// web/wasm_sim_test.cpp — WebAssembly sim bring-up test.
//
// Proves the OpenBW *simulation* compiles and runs under WebAssembly (WASI),
// with no UI/SDL at all. Run with a WASI host (Node's node:wasi) that preopens
// the game data + map directories. This de-risks the whole browser port before
// any canvas/JS backend exists.

#include "bwgame.h"
#include "actions.h"
#include <cstdio>
#include <cstring>

using namespace bwgame;

static int count_units(state& st, int owner) {
	int n = 0;
	for (unit_t* u : ptr(st.player_units.at(owner))) { (void)u; ++n; }
	return n;
}

static void require(bool result, const char* description) {
	if (!result) error("campaign check failed: %s", description);
}

static void campaign_audio_bounds_checks() {
	for (size_t channels : {size_t(1), size_t(2)}) {
		a_vector<uint8_t> input{0, 2};
		input.resize(2 + channels * 2, 0);
		input.insert(input.end(), 8, 0x80);
		std::array<uint8_t, 16> output;
		output.fill(0xa5);
		size_t capacity = channels == 1 ? 6 : 8;
		require(data_loading::decompress_adpcm(input.data(), input.size(), output.data() + 2, capacity, channels) == capacity, "ADPCM stops at the expected mono/stereo output size despite trailing encoded samples");
		for (size_t index = 2; index < capacity + 2; ++index) require(output[index] == 0, "bounded ADPCM retains the expected PCM samples");
		require(output[0] == 0xa5 && output[1] == 0xa5 && output[capacity + 2] == 0xa5, "ADPCM cannot overwrite output boundary guards");
		output.fill(0xa5);
		require(data_loading::decompress_adpcm(input.data(), input.size(), output.data() + 2, 1, channels) == 0 && output[2] == 0xa5 && output[3] == 0xa5, "ADPCM never writes half a sample into an odd-sized output buffer");
	}
	printf("Campaign ADPCM mono/stereo output boundary checks passed.\n");
}

static void original_campaign_availability_checks(const state& st) {
	for (int owner = 0; owner != 12; ++owner) {
		for (const auto& type : st.game->unit_types.vec) if (type.is_broodwar) require(!st.game->unit_type_allowed[owner][type.id], "original campaign excludes every Brood War unit for every player");
		for (const auto& upgrade : st.game->upgrade_types.vec) if (upgrade.is_broodwar) {
			require(st.game->max_upgrade_levels[owner][upgrade.id] == 0, "original campaign excludes every Brood War upgrade for every player");
			require(st.upgrade_levels[owner][upgrade.id] == 0, "original campaign cannot start with a Brood War upgrade");
		}
		for (int index = int(TechTypes::Restoration); index != int(TechTypes::None); ++index) {
			TechTypes tech = TechTypes(index);
			require(!st.game->tech_available[owner][tech] && !st.tech_researched[owner][tech], "original campaign excludes every Brood War technology for every player");
		}
	}
	printf("Original campaign availability excludes Brood War units, upgrades and technologies for all races and players.\n");
}

static void expansion_availability_checks(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int mode = 0; mode != 2; ++mode) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		a_vector<uint8_t> scenario;
		map_loader(scenario, "staredit/scenario.chk");
		require(scenario.size() >= 10 && memcmp(scenario.data(), "VER ", 4) == 0 && data_loading::value_at<uint32_t, true>(scenario.data() + 4) == 2, "availability fixture begins with a normal scenario version section");
		if (mode == 0) data_loading::set_value_at<true>(scenario.data() + 8, uint16_t(63));
		game_load_functions loader(player.st());
		loader.setup_info.victory_condition = mode;
		loader.setup_info.starting_minerals = 0;
		loader.load_map_data(scenario.data(), scenario.size());
		const auto& st = player.st();
		for (UnitTypes type : {UnitTypes::Terran_Medic, UnitTypes::Terran_Valkyrie, UnitTypes::Protoss_Corsair, UnitTypes::Protoss_Dark_Templar, UnitTypes::Protoss_Dark_Archon, UnitTypes::Zerg_Devourer, UnitTypes::Zerg_Lurker}) require(st.game->unit_type_allowed[1][type], "hybrid and melee modes retain Brood War unit availability");
		for (const auto& upgrade : st.game->upgrade_types.vec) if (upgrade.is_broodwar) require(st.game->max_upgrade_levels[1][upgrade.id] == upgrade.max_level, "hybrid and melee modes retain expansion upgrade defaults");
		for (int index = int(TechTypes::Restoration); index != int(TechTypes::None); ++index) require(st.game->tech_available[1][TechTypes(index)], "hybrid and melee modes retain expansion technology defaults");
	}
	printf("Hybrid-format maps and melee retain Brood War units, upgrades and technologies.\n");
}

static void cloaked_targeting_checks(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	bool matches_classic = true;
	for (UnitTypes type : {UnitTypes::Terran_Wraith, UnitTypes::Terran_Ghost}) for (bool hold : {false, true}) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.victory_condition = 2;
		loader.setup_info.tournament_mode = 0;
		loader.setup_info.starting_units = 0;
		loader.setup_info.resource_type = 0;
		loader.setup_info.starting_minerals = 0;
		loader.setup_info.create_melee_units_for_player = {};
		loader.setup_info.create_no_units = true;
		loader.load_map(map_loader, {}, false);
		auto& st = player.st();
		require(st.game->triggers.empty(), "isolated combat fixture has no campaign or melee outcome triggers");
		action_state commands;
		action_functions functions(st, commands);
		unit_t* attacker = functions.trigger_create_unit(functions.get_unit_type(type), xy(192, 96), 1);
		unit_t* opponent = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Zerg_Overlord), xy(1536, 1536), 4);
		require(attacker && opponent, "both fixture players remain active before the cloaking setup");
		TechTypes tech = type == UnitTypes::Terran_Wraith ? TechTypes::Cloaking_Field : TechTypes::Personnel_Cloaking;
		st.game->tech_available[1][tech] = true;
		st.tech_researched[1][tech] = false;
		st.tech_researching[1][tech] = true;
		attacker->energy = fp8::integer(200);
		functions.action_select(1, attacker);
		functions.action_cloak(1);
		require(attacker->energy == fp8::integer(200) && attacker->secondary_order_type->id != Orders::Cloak, "player cloak command cannot bypass unfinished research");
		st.tech_researching[1][tech] = false;
		st.tech_researched[1][tech] = true;
		st.game->tech_available[1][tech] = false;
		functions.action_cloak(1);
		require(attacker->energy == fp8::integer(200) && attacker->secondary_order_type->id != Orders::Cloak, "player cloak command cannot bypass mission technology restrictions");
		st.game->tech_available[1][tech] = true;
		functions.action_cloak(1);
		require(attacker->secondary_order_type->id == Orders::Cloak && attacker->energy == fp8::integer(200 - functions.get_tech_type(tech)->energy_cost), "completed cloak research enables the normal paid player command");
		for (int tick = 0; tick != 64 && !functions.u_cloaked(attacker); ++tick) functions.next_frame();
		require(functions.u_cloaked(attacker), "attacker enters native cloaking before automatic combat");
		xy position = attacker->sprite->position;
		unit_t* target = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_SCV), position + xy(96, 0), 4);
		require(target, "native nearby ground target for isolated cloaked combat");
		functions.set_unit_order(attacker, functions.get_order_type(hold ? Orders::HoldPosition : attacker->unit_type->return_to_idle->id));
		functions.set_unit_order(target, functions.get_order_type(Orders::HoldPosition));
		bool fired = false;
		bool damaged = false;
		for (int tick = 0; tick != 192 && !(fired && damaged); ++tick) {
			target->defensive_matrix_hp = fp8::integer(64000);
			target->defensive_matrix_timer = 250;
			functions.next_frame();
			fired = fired || attacker->ground_weapon_cooldown || attacker->air_weapon_cooldown;
			damaged = damaged || target->defensive_matrix_hp < fp8::integer(64000);
		}
		bool expected_fire = type != UnitTypes::Terran_Ghost || hold;
		printf("Cloaked targeting: unit=%s order=%s fired=%d damaged=%d expected=%d\n", type == UnitTypes::Terran_Ghost ? "Ghost" : "Wraith", hold ? "HoldPosition" : "Idle", fired, damaged, expected_fire);
		if (fired != expected_fire || damaged != fired) {
			printf("Cloaked combat diagnostic: type=%d hold=%d fired=%d damaged=%d frame=%d order=%d target=%d target_hp=%d\n", int(type), hold, fired, damaged, st.current_frame, int(attacker->order_type->id), attacker->order_target.unit == target, target->hp.integer_part());
			printf("Cloaked acquisition diagnostic: hostile=%d attackable=%d visible=%d range=%d distance=%d source_owner=%d target_owner=%d source_controller=%d target_controller=%d\n", functions.unit_target_is_enemy(attacker, target), functions.unit_can_attack_target(attacker, target), functions.unit_can_see_target(attacker, target), functions.unit_target_acquisition_range(attacker), functions.units_distance(attacker, target), attacker->owner, target->owner, st.players[attacker->owner].controller, st.players[target->owner].controller);
		}
		matches_classic = matches_classic && fired == expected_fire && damaged == fired;
		require(functions.u_cloaked(attacker), "automatic firing does not require decloaking");
		if (hold) require(attacker->sprite->position == position, "Hold Position never chases the enemy");
		if (type == UnitTypes::Terran_Ghost) {
			functions.issue_order(attacker, false, functions.get_order_type(Orders::AttackUnit), {target->sprite->position, target});
			bool manual_damage = false;
			for (int tick = 0; tick != 96 && !manual_damage; ++tick) { target->defensive_matrix_hp = fp8::integer(64000); target->defensive_matrix_timer = 250; functions.next_frame(); manual_damage = target->defensive_matrix_hp < fp8::integer(64000); }
			require(manual_damage && functions.u_cloaked(attacker), "explicit Attack makes an idle or held cloaked Ghost deal new damage without decloaking");
			printf("Cloaked Ghost explicit Attack after %s: damaged=1 cloaked=1\n", hold ? "HoldPosition" : "Idle");
		}
	}
	fflush(stdout);
	require(matches_classic, "cloaked Ghost is silent idle, fires on Hold Position or explicit Attack; cloaked Wraith fires idle and on Hold Position");
	printf("Cloaked Wraith/Ghost idle, Hold, explicit Attack and player cloak research guards passed.\n");
}

static void ownership_transfer_checks(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	game_player player(load_data_file);
	data_loading::mpq_file<> map_loader(map_file);
	game_load_functions loader(player.st());
	loader.setup_info.starting_minerals = 0;
	loader.load_map(map_loader);
	auto& st = player.st();
	state_functions functions(st);
	st.game->tech_available[1][TechTypes::Stim_Packs] = true;
	unit_t* marine = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Marine), xy(192, 96), 4);
	require(marine != nullptr, "ownership-transfer fixture creates a source Marine");
	st.tech_researched[1][TechTypes::Stim_Packs] = false;
	st.tech_researched[4][TechTypes::Stim_Packs] = false;
	require(functions.trigger_give_unit_to(marine, 1) && !functions.player_has_researched(1, TechTypes::Stim_Packs), "scripted transfer does not invent technology absent from the source owner");
	functions.trigger_give_unit_to(marine, 4);
	st.tech_researched[4][TechTypes::Stim_Packs] = true;
	st.upgrade_levels[4][UpgradeTypes::U_238_Shells] = 1;
	require(functions.trigger_give_unit_to(marine, 1) && functions.player_has_researched(1, TechTypes::Stim_Packs) && functions.player_upgrade_level(1, UpgradeTypes::U_238_Shells) == 1, "scripted transfer retains researched source technology and range upgrades");

	unit_t* bunker = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Bunker), xy(384, 160), 2);
	unit_t* passenger = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Marine), xy(384, 224), 2);
	require(bunker && passenger, "single-bunker rescue fixture creates original-owner cargo");
	functions.unit_load_target(bunker, passenger);
	functions.set_unit_order(passenger, functions.get_order_type(Orders::RescuePassive));
	unit_id passenger_id = functions.get_unit_id(passenger);
	int bunker_color = bunker->sprite->owner, passenger_color = passenger->sprite->owner;
	st.tech_researched[2][TechTypes::Stim_Packs] = true;
	st.upgrade_levels[2][UpgradeTypes::U_238_Shells] = 1;
	st.tech_researched[1][TechTypes::Stim_Packs] = false;
	st.upgrade_levels[1][UpgradeTypes::U_238_Shells] = 0;
	functions.move_unit(marine, bunker->sprite->position + xy(48, 0));
	bunker->main_order_timer = 0;
	functions.order_RescuePassive(bunker);
	require(bunker->owner == 1 && passenger->owner == 1 && functions.get_unit(passenger_id) == passenger && passenger->connected_unit == bunker && functions.u_loaded(passenger) && functions.u_in_bunker(passenger) && functions.us_hidden(passenger), "single-bunker proximity rescue preserves hidden loaded cargo identity and containment");
	require(passenger->order_type->id == Orders::BunkerGuard && bunker->sprite->owner == bunker_color && passenger->sprite->owner == passenger_color, "single-bunker rescue restores native garrison guard and original display colors");
	require(!functions.player_has_researched(1, TechTypes::Stim_Packs) && functions.player_upgrade_level(1, UpgradeTypes::U_238_Shells) == 0, "rescue does not inherit even researched source technology or upgrades");
	st.tech_researched[1][TechTypes::Stim_Packs] = true;
	st.upgrade_levels[1][UpgradeTypes::U_238_Shells] = 1;
	functions.trigger_give_unit_to(passenger, 2, true, true);
	st.tech_researched[2][TechTypes::Stim_Packs] = false;
	st.upgrade_levels[2][UpgradeTypes::U_238_Shells] = 0;
	functions.trigger_give_unit_to(passenger, 1, true, true);
	require(functions.player_has_researched(1, TechTypes::Stim_Packs) && functions.player_upgrade_level(1, UpgradeTypes::U_238_Shells) == 1, "rescue preserves the recipient's existing research and upgrades");
	printf("Scripted technology transfer and ownership-only bunker rescue checks passed.\n");
}

static void shared_combat_ai_checks(state& st) {
	state_functions functions(st);
	xy original(192, 96);
	unit_t* ai_marine = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Marine), original, 4);
	unit_t* stim_target = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Firebat), original + xy(96, 0), 1);
	require(ai_marine && stim_target, "shared campaign combat fixture actors");
	st.game->tech_available[4][TechTypes::Stim_Packs] = true;
	st.tech_researched[4][TechTypes::Stim_Packs] = false;
	require(!functions.try_campaign_ai_stim(ai_marine, stim_target) && !ai_marine->stim_timer && ai_marine->hp == fp8::integer(40), "AI Marine cannot Stim before research completes even when the technology is available");
	st.tech_researched[4][TechTypes::Stim_Packs] = true;
	st.game->tech_available[4][TechTypes::Stim_Packs] = false;
	require(!functions.try_campaign_ai_stim(ai_marine, stim_target) && ai_marine->hp == fp8::integer(40), "AI Stim cannot bypass disabled mission technology");
	st.game->tech_available[4][TechTypes::Stim_Packs] = true;
	require(functions.try_campaign_ai_stim(ai_marine, stim_target), "computer Marine uses native Stim when engaging at healthy HP");
	require(ai_marine->hp == fp8::integer(30) && ai_marine->stim_timer == 37, "AI Stim retains the native ten HP cost and duration");
	require(!functions.try_campaign_ai_stim(ai_marine, stim_target) && ai_marine->hp == fp8::integer(30), "AI does not repeat Stim while active");
	ai_marine->stim_timer = 0;
	require(!functions.try_campaign_ai_stim(ai_marine, stim_target), "AI does not drain an already wounded Marine");
	printf("Shared campaign Stim decision checks passed.\n");
	unit_t* threat = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Marine), original + xy(96, 0), 1);
	unit_t* wraith = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Wraith), original, 4);
	require(threat && wraith, "Wraith engagement fixture actors");
	st.game->tech_available[4][TechTypes::Cloaking_Field] = true;
	st.tech_researched[4][TechTypes::Cloaking_Field] = false;
	threat->sprite->visibility_flags |= 1 << 4;
	wraith->energy = fp8::integer(100);
	require(!functions.try_campaign_ai_wraith_cloak(wraith, threat) && wraith->energy == fp8::integer(100) && wraith->secondary_order_type->id != Orders::Cloak, "AI Wraith cannot cloak before research completes even with enough energy");
	st.tech_researched[4][TechTypes::Cloaking_Field] = true;
	st.game->tech_available[4][TechTypes::Cloaking_Field] = false;
	require(!functions.try_campaign_ai_wraith_cloak(wraith, threat) && wraith->energy == fp8::integer(100), "AI cloak cannot bypass disabled mission technology");
	st.game->tech_available[4][TechTypes::Cloaking_Field] = true;
	require(functions.try_campaign_ai_wraith_cloak(wraith, threat), "Wraith cloaks at a nearby anti-air engagement");
	require(wraith->energy == fp8::integer(75) && wraith->secondary_order_type->id == Orders::Cloak, "AI cloak pays the native energy cost");
	require(!functions.try_campaign_ai_wraith_cloak(wraith, threat) && wraith->energy == fp8::integer(75), "pending cloak is not charged twice");
	require(functions.try_campaign_ai_wraith_cloak(wraith, nullptr) && wraith->secondary_order_type->id == Orders::Decloak, "Wraith stops wasting cloak energy outside combat");
	functions.set_secondary_order(wraith, functions.get_order_type(Orders::Nothing));
	functions.move_unit(threat, original + xy(640, 0));
	require(!functions.try_campaign_ai_wraith_cloak(wraith, threat), "Wraith does not cloak miles before combat");
	unit_t* tank = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Siege_Tank_Tank_Mode), original + xy(0, 128), 4);
	require(tank, "AI tank fixture actor");
	st.game->tech_available[4][TechTypes::Tank_Siege_Mode] = true;
	st.tech_researched[4][TechTypes::Tank_Siege_Mode] = true;
	xy tank_spawn = tank->sprite->position;
	functions.move_unit(tank, xy(1024, 1024));
	functions.move_unit(threat, tank->sprite->position + xy(320, 0));
	threat->sprite->visibility_flags |= 1 << 4;
	functions.queue_order_back(tank, functions.get_order_type(Orders::AttackMove), {xy(1680, 1024), nullptr});
	require(functions.try_campaign_ai_siege(tank) && tank->order_type->id == Orders::Sieging, "AI tank deploys for a target beyond tank range but inside siege range");
	bool retained_destination = false;
	for (const order_t* queued : ptr(tank->order_queue)) if (queued->order_type->id == Orders::AttackMove && queued->target.position == xy(1680, 1024)) retained_destination = true;
	require(retained_destination, "mode changes retain the AI's queued strategic movement destination");
	threat->hp = fp8::integer(2000);
	for (int tick = 0; tick != 240 && (!functions.unit_is_sieged_tank(tank) || tank->order_type->id == Orders::Sieging || functions.u_order_not_interruptible(tank) || functions.u_iscript_nobrk(tank)); ++tick) functions.next_frame();
	require(functions.unit_is_sieged_tank(tank) && tank->order_type->id != Orders::Sieging, "native siege animation completes before the close-range encounter");
	require(functions.campaign_ai_type(tank->unit_type->id) == UnitTypes::Terran_Siege_Tank_Tank_Mode, "sieged tanks still satisfy the same AI army and production request");
	functions.move_unit(threat, tank->sprite->position + xy(32, 0));
	threat->sprite->visibility_flags |= 1 << 4;
	require(functions.try_campaign_ai_siege(tank) && tank->order_type->id == Orders::Unsieging, "AI unsieges to fight a Marine inside siege minimum range");
	for (int tick = 0; tick != 240 && (!functions.unit_is_unsieged_tank(tank) || tank->order_type->id == Orders::Unsieging); ++tick) functions.next_frame();
	require(functions.unit_is_unsieged_tank(tank) && tank->order_type->id != Orders::Unsieging, "native unsiege animation completes");
	auto close_target_hp = threat->hp;
	for (int tick = 0; tick != 180 && threat->hp == close_target_hp; ++tick) functions.next_frame();
	require(functions.unit_is_unsieged_tank(tank) && threat->hp < close_target_hp, "unsieged AI tank fires its native gun at the close Marine");
	printf("Shared campaign Wraith and tank decision checks passed.\n");
	unit_t* victim = functions.create_initial_unit(functions.get_unit_type(UnitTypes::Terran_Goliath), tank_spawn, 4);
	unit_t* attacker = functions.create_initial_unit(functions.get_unit_type(UnitTypes::Terran_Wraith), tank_spawn + xy(128, 0), 1);
	unit_t* comsat = functions.create_initial_unit(functions.get_unit_type(UnitTypes::Terran_Comsat_Station), xy(1280, 896), 4);
	unit_t* detector = functions.create_initial_unit(functions.get_unit_type(UnitTypes::Terran_Science_Vessel), tank_spawn + xy(128, 64), 4);
	require(victim, "native placed anti-air victim fixture actor");
	require(attacker, "native placed cloaked attacker fixture actor");
	require(detector, "native placed detector fixture actor");
	require(comsat, "native placed Comsat fixture actor");
	st.game->tech_available[4][TechTypes::Scanner_Sweep] = true;
	functions.u_set_status_flag(attacker, unit_t::status_flag_cloaked);
	functions.u_set_status_flag(attacker, unit_t::status_flag_requires_detector);
	attacker->detected_flags = 1 << 1;
	attacker->sprite->visibility_flags |= 1 << 4;
	comsat->energy = fp8::integer(100);
	require(!functions.try_campaign_ai_scan(4, attacker) && comsat->energy == fp8::integer(100), "working detector coverage avoids wasting a scan even before cached detection refresh");
	functions.move_unit(detector, xy(1024, 256));
	comsat->energy = fp8::integer(49);
	require(!functions.try_campaign_ai_scan(4, attacker), "AI cannot scan without the native energy cost");
	comsat->energy = fp8::integer(100);
	functions.unit_deal_damage(victim, fp8::integer(1), attacker, 1);
	require(comsat->order_type->id == Orders::CastScannerSweep, "damage from an undetected Wraith requests a native Comsat scan");
	require(!functions.try_campaign_ai_scan(4, attacker), "pending nearby scan is not duplicated");
	functions.order_CastScannerSweep(comsat);
	require(comsat->energy == fp8::integer(50), "native scan pays exactly fifty energy");
	require(!functions.try_campaign_ai_scan(4, attacker), "existing scan coverage is not duplicated");
	functions.update_unit_detected_flags(attacker);
	require(!functions.unit_target_is_undetected(victim, attacker), "the native sweep reveals the attacker for retaliation");
	printf("Shared campaign reactive scan checks passed.\n");
	unit_t* automatic_marine = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Marine), tank_spawn + xy(64, 0), 4);
	require(automatic_marine, "automatic shared AI Marine fixture");
	automatic_marine->defensive_matrix_hp = fp8::integer(1000);
	automatic_marine->defensive_matrix_timer = 100;
	functions.move_unit(threat, automatic_marine->sprite->position + xy(96, 0));
	functions.issue_order(automatic_marine, false, functions.get_order_type(Orders::AttackUnit), {threat->sprite->position, threat});
	require(!st.campaign_ai[4].town_active, "combat fixture has no active town script");
	for (int tick = 0; tick != 64 && !automatic_marine->stim_timer; ++tick) functions.next_frame();
	require(automatic_marine->stim_timer > 0 && automatic_marine->hp <= fp8::integer(30), "ordinary frame progression activates shared Stim without a town script");
	unit_t* automatic_wraith = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Wraith), automatic_marine->sprite->position + xy(0, 64), 4);
	require(automatic_wraith, "automatic shared AI Wraith fixture");
	automatic_wraith->energy = fp8::integer(49);
	require(!functions.try_campaign_ai_wraith_cloak(automatic_wraith, threat), "AI conserves too little energy for a useful cloak interval");
	automatic_wraith->energy = fp8::integer(100);
	automatic_wraith->hp = fp8::integer(1000);
	functions.issue_order(automatic_wraith, false, functions.get_order_type(Orders::AttackUnit), {threat->sprite->position, threat});
	for (int tick = 0; tick != 64 && automatic_wraith->secondary_order_type->id != Orders::Cloak; ++tick) functions.next_frame();
	require(automatic_wraith->secondary_order_type->id == Orders::Cloak && automatic_wraith->energy < fp8::integer(100), "ordinary frame progression activates paid cloak near engagement");
	st.game->tech_available[1][TechTypes::Stim_Packs] = true;
	st.tech_researched[1][TechTypes::Stim_Packs] = true;
	require(!functions.try_campaign_ai_stim(threat, automatic_marine) && !threat->stim_timer, "human-controlled units never receive automatic combat abilities");
	automatic_marine->stim_timer = 0; automatic_marine->hp = fp8::integer(40);
	st.tech_researched[4][TechTypes::Stim_Packs] = false;
	require(!functions.try_campaign_ai_stim(automatic_marine, threat), "automatic Stim cannot bypass original research requirements");
	st.tech_researched[4][TechTypes::Stim_Packs] = true;
	functions.kill_unit(threat);
	require(!functions.try_campaign_ai_stim(automatic_marine, threat) && automatic_marine->hp == fp8::integer(40), "AI does not spend health on an already dying target");
	action_state player_commands;
	action_functions player_actions(st, player_commands);
	unit_t* player_marine = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Marine), original, 1);
	require(player_marine, "native player Marine for Stim command research guards");
	player_actions.action_select(1, player_marine);
	st.tech_researched[1][TechTypes::Stim_Packs] = false;
	st.tech_researching[1][TechTypes::Stim_Packs] = true;
	player_actions.action_stim_pack(1);
	require(!player_marine->stim_timer && player_marine->hp == fp8::integer(40), "player Stim command cannot bypass unfinished research");
	st.tech_researching[1][TechTypes::Stim_Packs] = false;
	st.tech_researched[1][TechTypes::Stim_Packs] = true;
	st.game->tech_available[1][TechTypes::Stim_Packs] = false;
	player_actions.action_stim_pack(1);
	require(!player_marine->stim_timer && player_marine->hp == fp8::integer(40), "player Stim command cannot bypass disabled mission technology");
	st.game->tech_available[1][TechTypes::Stim_Packs] = true;
	player_actions.action_stim_pack(1);
	require(player_marine->stim_timer == 37 && player_marine->hp == fp8::integer(30), "completed Stim research enables the normal paid player command");
	for (auto sample : {std::make_pair(UnitTypes::Hero_Jim_Raynor_Marine, TechTypes::Stim_Packs), std::make_pair(UnitTypes::Hero_Tom_Kazansky, TechTypes::Cloaking_Field), std::make_pair(UnitTypes::Hero_Sarah_Kerrigan, TechTypes::Personnel_Cloaking)}) {
		unit_t* hero = functions.trigger_create_unit(functions.get_unit_type(sample.first), original, 1);
		require(hero, "native hero for innate ability research exception");
		st.game->tech_available[1][sample.second] = true;
		st.tech_researched[1][sample.second] = false;
		hero->energy = fp8::integer(200);
		auto hp = hero->hp;
		player_actions.action_select(1, hero);
		if (sample.second == TechTypes::Stim_Packs) {
			player_actions.action_stim_pack(1);
			require(hero->stim_timer == 37 && hero->hp == hp - fp8::integer(10), "Raynor's innate Stim does not require the player's ordinary Marine research");
		} else {
			player_actions.action_cloak(1);
			require(hero->secondary_order_type->id == Orders::Cloak && hero->energy == fp8::integer(200 - functions.get_tech_type(sample.second)->energy_cost), "hero cloak uses the native paid command without ordinary-unit research");
		}
		st.game->tech_available[1][sample.second] = false;
		require(!functions.unit_can_use_tech(hero, functions.get_tech_type(sample.second)), "hero research exception does not bypass disabled mission technology");
	}
	printf("Player Stim research guards and native hero ability exceptions passed.\n");
	printf("Shared combat frame integration and human-control isolation checks passed.\n");
}

static void campaign_checks(state& st) {
	struct observed_functions : state_functions {
		using state_functions::state_functions;
		a_vector<int> events;
		void on_trigger_action(int, const trigger::action& action) override { events.push_back(action.type); }
	} functions(st);
	require(count_units(st, 1) == 12 && count_units(st, 2) == 1 && count_units(st, 4) == 23 && count_units(st, 11) == 10, "original 46 actors");
	for (UnitTypes type : {UnitTypes::Terran_Marine, UnitTypes::Terran_SCV, UnitTypes::Terran_Command_Center, UnitTypes::Terran_Supply_Depot, UnitTypes::Terran_Barracks}) require(st.game->unit_type_allowed[1][type], "original mission unit availability");
	for (UnitTypes type : {UnitTypes::Terran_Ghost, UnitTypes::Terran_Factory, UnitTypes::Terran_Starport}) require(!st.game->unit_type_allowed[1][type], "original mission unit restrictions");
	for (UnitTypes type : {UnitTypes::Terran_Medic, UnitTypes::Terran_Valkyrie}) require(!st.game->unit_type_allowed[1][type], "original retail mission excludes Brood War units");
	require(!functions.player_tech_available(1, TechTypes::Stim_Packs), "original mission tech restrictions");
	unit_t* marine = nullptr;
	unit_t* raynor = nullptr;
	for (unit_t* unit : ptr(st.player_units[1])) if (unit->unit_type->id == UnitTypes::Terran_Marine) marine = unit;
	for (unit_t* unit : ptr(st.player_units[2])) raynor = unit;
	require(marine && raynor, "human Marine and rescue Raynor");
	int raynor_color = raynor->sprite->owner;
	xy original = marine->sprite->position;
	functions.move_unit(marine, raynor->sprite->position + xy(96, 0));
	functions.order_RescuePassive(raynor);
	require(raynor->owner == 2, "out-of-range unit must not rescue");
	functions.move_unit(marine, raynor->sprite->position + xy(48, 0));
	raynor->main_order_timer = 0;
	functions.order_RescuePassive(raynor);
	require(raynor->owner == 1 && raynor->order_type->id != Orders::RescuePassive, "proximity transfers ownership and restores human idle order");
	require(raynor->sprite->owner == raynor_color, "rescued hero retains its original display color");
	unit_t* rescue_transport = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Dropship), raynor->sprite->position + xy(96, 0), 1);
	require(rescue_transport && rescue_transport->sprite->owner != raynor->sprite->owner, "transport fixture has matching ownership but different display colors");
	require(functions.unit_can_load_target(rescue_transport, raynor), "transport eligibility uses ownership rather than display color");
	functions.set_sprite_owner(rescue_transport, raynor_color);
	functions.set_unit_owner(rescue_transport, 2, false);
	require(!functions.unit_can_load_target(rescue_transport, raynor), "matching display colors do not permit loading another owner's unit");
	functions.kill_unit(rescue_transport);
	unit_t* rescue_tank = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Siege_Tank_Tank_Mode), raynor->sprite->position + xy(32, 0), 2);
	require(rescue_tank && rescue_tank->subunit, "rescue fixture includes a tank and turret");
	int tank_color = rescue_tank->sprite->owner;
	int turret_color = rescue_tank->subunit->sprite->owner;
	rescue_tank->main_order_timer = 0;
	functions.order_RescuePassive(rescue_tank);
	require(rescue_tank->owner == 1 && rescue_tank->subunit->owner == 1, "rescue transfers both tank and turret ownership");
	require(rescue_tank->sprite->owner == tank_color && rescue_tank->subunit->sprite->owner == turret_color, "rescued tank and turret retain their display colors");
	functions.morph_unit(rescue_tank, functions.get_unit_type(UnitTypes::Terran_Siege_Tank_Siege_Mode));
	require(rescue_tank->owner == 1 && rescue_tank->sprite->owner == tank_color && rescue_tank->subunit->sprite->owner == turret_color, "siege transformation preserves rescued display colors");
	functions.kill_unit(rescue_tank);
	functions.trigger_give_unit_to(raynor, 4);
	require(raynor->owner == 4 && raynor->sprite->owner == 4, "normal ownership transfer still recolors as required by mind control");
	functions.trigger_give_unit_to(raynor, 1);
	functions.move_unit(marine, original);
	printf("Campaign rescue checks passed.\n");

	trigger::condition condition{};
	condition.type = 2;
	condition.group = 13;
	condition.unit_id = 0;
	condition.num_n = 10;
	condition.count_n = 5;
	require(functions.test_trigger_condition(condition, 1), "raw Exactly 10 comparison");
	condition.count_n = 4;
	require(!functions.test_trigger_condition(condition, 1), "Exactly negative boundary");
	condition.group = 18;
	condition.count_n = 5;
	require(functions.test_trigger_condition(condition, 1), "Force ownership expansion");
	condition.group = 17;
	condition.unit_id = 19;
	condition.count_n = 1;
	require(functions.test_trigger_condition(condition, 1), "All Players includes rescued Raynor");
	st.current_minerals[1] = 40;
	st.current_gas[1] = 10;
	st.total_minerals_gathered[1] = 1000;
	condition.type = 4;
	condition.group = 13;
	condition.extra_n = 0;
	condition.count_n = 40;
	require(functions.test_trigger_condition(condition, 1), "Accumulate uses current holdings");
	condition.extra_n = 2;
	condition.count_n = 50;
	require(functions.test_trigger_condition(condition, 1), "Accumulate combined minerals and gas");
	condition.type = 12;
	condition.num_n = 0;
	condition.count_n = 8;
	st.current_frame = 127;
	require(!functions.test_trigger_condition(condition, 1), "eight elapsed game seconds is not 127 frames");
	st.current_frame = 128;
	require(functions.test_trigger_condition(condition, 1), "eight elapsed game seconds is 128 frames");
	st.current_frame = 0;
	printf("Campaign condition checks passed.\n");

	state_functions::execute_trigger_struct effects;
	running_trigger running;
	trigger::action action{};
	action.type = 26;
	action.group_n = 13;
	action.group2_n = 60;
	action.extra_n = 0;
	action.num_n = 9;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	require(st.current_minerals[1] == 0, "resource subtraction clamps underflow");
	action.num_n = 7;
	action.group2_n = 40;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	action.num_n = 8;
	action.group2_n = 2;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	require(st.current_minerals[1] == 42, "resource set and add modifiers");
	st.locations.emplace_back();
	st.locations.emplace_back();
	size_t destination = st.locations.size() - 2;
	size_t search = destination + 1;
	st.locations[destination].area = {{0, 0}, {32, 32}};
	st.locations[destination].elevation_flags = 0;
	st.locations[search].area = functions.square_at(marine->sprite->position, 1);
	st.locations[search].elevation_flags = 0;
	action = {};
	action.type = 38;
	action.location = int(search + 1);
	action.group2_n = int(destination + 1);
	action.group_n = 13;
	action.extra_n = 0;
	unit_t* located = functions.trigger_find_unit(1, st.locations[search], 13, 0);
	require(located != nullptr, "Move Location search fixture");
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	const auto& moved = st.locations[destination].area;
	require((moved.from + moved.to) / 2 == located->sprite->position, "Move Location centers destination on source match");
	require(moved.to - moved.from == xy(32, 32), "Move Location preserves destination extents");

	st.running_triggers = {};
	st.trigger_waiting = {};
	st.trigger_wait_timers = {};
	st.trigger_timer = 0;
	st.current_minerals[1] = 0;
	trigger authored{};
	authored.conditions[0].type = 255;
	authored.conditions[0].flags = 2;
	action = {};
	action.type = 26;
	action.group_n = 13;
	action.num_n = 8;
	authored.actions[0] = action;
	authored.actions[0].group2_n = 1;
	authored.actions[1].type = 4;
	authored.actions[1].time_n = 84;
	authored.actions[2] = action;
	authored.actions[2].group2_n = 10;
	authored.actions[3].flags = 2;
	authored.actions[4] = action;
	authored.actions[4].group2_n = 100;
	st.running_triggers[1].emplace_back();
	st.running_triggers[1].back().t = &authored;
	functions.process_triggers();
	require(st.current_minerals[1] == 1, "disabled condition ignored before a wait");
	for (int tick = 0; tick != 4; ++tick) functions.process_triggers();
	require(st.current_minerals[1] == 11, "wait resumes without repeating earlier mutations");
	for (int tick = 0; tick != 80; ++tick) functions.process_triggers();
	require(st.current_minerals[1] == 11, "one-shot trigger remains complete");
	st.running_triggers = {};
	printf("Campaign resource and continuation checks passed.\n");

	trigger paused{};
	paused.actions[0].type = 5;
	paused.actions[1].type = 4;
	paused.actions[1].time_n = 0;
	paused.actions[2].type = 6;
	paused.actions[3] = action;
	paused.actions[3].group2_n = 20;
	st.current_minerals[1] = 0;
	st.trigger_timer = 0;
	st.running_triggers[1].emplace_back();
	st.running_triggers[1].back().t = &paused;
	functions.next_frame();
	int paused_at = st.current_frame;
	functions.next_frame();
	require(st.current_frame == paused_at && st.current_minerals[1] == 0, "script pause freezes world while minimum wait remains blocked");
	functions.next_frame();
	require(st.current_frame == paused_at && st.current_minerals[1] == 20, "script wait reaches unpause without advancing world clock");
	functions.next_frame();
	require(st.current_frame == paused_at + 1, "world resumes after scripted unpause");
	st.running_triggers = {};
	printf("Campaign clock and pause checks passed.\n");
	trigger::action original_transmission{};
	original_transmission.type = 7;
	original_transmission.sound_index = 1;
	original_transmission.time_n = 3956;
	original_transmission.group2_n = 0;
	original_transmission.num_n = 9;
	require(functions.trigger_transmission_duration(original_transmission) == 3956, "transmission uses stored base duration minus adjustment");
	trigger presentation{};
	presentation.actions[0].type = 9;
	presentation.actions[1].type = 7;
	presentation.actions[1].sound_index = 1;
	presentation.actions[1].num_n = 7;
	presentation.actions[1].time_n = 100;
	presentation.actions[1].group2_n = 84;
	presentation.actions[2].type = 12;
	presentation.actions[3].type = 17;
	presentation.actions[4].type = 30;
	presentation.actions[5].type = 31;
	presentation.actions[6].type = 32;
	st.trigger_timer = 0;
	st.running_triggers[1].emplace_back();
	st.running_triggers[1].back().t = &presentation;
	functions.process_triggers();
	require(functions.events == a_vector<int>({9, 7}), "transmission emits ordered events before waiting");
	for (int tick = 0; tick != 4; ++tick) functions.process_triggers();
	require(functions.events == a_vector<int>({9, 7, 12, 17, 30, 31, 32}), "transmission resumes without duplicate presentation");
	presentation.actions[1].num_n = 8;
	require(functions.trigger_transmission_duration(presentation.actions[1]) == 184, "transmission adds to audio duration");
	presentation.actions[1].num_n = 9;
	require(functions.trigger_transmission_duration(presentation.actions[1]) == 16, "transmission subtracts from audio duration");
	presentation.actions[1].group2_n = 200;
	require(functions.trigger_transmission_duration(presentation.actions[1]) == 0, "transmission subtraction clamps at zero");
	st.running_triggers = {};
	printf("Campaign presentation event checks passed.\n");
	trigger earlier{};
	earlier.actions[0] = action;
	earlier.actions[0].group2_n = 1;
	earlier.actions[1].type = 3;
	trigger later{};
	later.actions[0].type = 4;
	later.actions[0].time_n = 84;
	st.current_minerals[1] = 0;
	st.trigger_timer = 0;
	st.running_triggers[1].emplace_back();
	st.running_triggers[1].back().t = &earlier;
	st.running_triggers[1].emplace_back();
	st.running_triggers[1].back().t = &later;
	functions.process_triggers();
	require(st.current_minerals[1] == 2, "starting Wait rechecks earlier preserved triggers");
	st.running_triggers = {};
	printf("Campaign earlier-trigger recheck passed.\n");
	const std::pair<int, int> wait_boundaries[] = {{0, 2}, {42, 2}, {43, 3}, {84, 3}, {85, 4}};
	for (const auto& boundary : wait_boundaries) {
		trigger quantized{};
		quantized.actions[0].type = 4;
		quantized.actions[0].time_n = boundary.first;
		quantized.actions[1] = action;
		quantized.actions[1].group2_n = 1;
		st.current_minerals[1] = 0;
		st.trigger_timer = 0;
		st.trigger_waiting = {};
		st.trigger_wait_timers = {};
		st.running_triggers[1].emplace_back();
		st.running_triggers[1].back().t = &quantized;
		functions.process_triggers();
		int ticks = 0;
		while (!st.current_minerals[1] && ticks < 8) { functions.process_triggers(); ++ticks; }
		if (ticks != boundary.second) error("Wait %d ms: expected %d ticks, got %d", boundary.first, boundary.second, ticks);
		st.running_triggers = {};
	}
	printf("Campaign wait quantization checks passed.\n");
	trigger::action countdown{};
	countdown.type = 14;
	countdown.time_n = 1800;
	countdown.num_n = 7;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], countdown);
	require(st.countdown_timer == 1800, "Desperate Alliance sets an actual thirty-minute countdown");
	countdown.time_n = 5;
	countdown.num_n = 8;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], countdown);
	require(st.countdown_timer == 1805, "countdown add modifier");
	countdown.time_n = 2000;
	countdown.num_n = 9;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], countdown);
	require(st.countdown_timer == 0, "countdown subtraction clamps at zero");
	printf("Campaign countdown action checks passed.\n");
	unit_t* killed_building = nullptr;
	for (unit_t* unit : ptr(st.player_units[1])) if (unit->unit_type->id == UnitTypes::Terran_Supply_Depot) killed_building = unit;
	require(killed_building != nullptr, "building-kill fixture");
	functions.set_unit_owner(killed_building, 4, true);
	condition = {};
	condition.type = 5;
	condition.group = 18;
	condition.unit_id = 231;
	condition.num_n = 10;
	require(functions.test_trigger_condition(condition, 1), "building kills initially zero");
	functions.unit_deal_damage(killed_building, 1_fp8, marine, 1, false);
	require(functions.test_trigger_condition(condition, 1), "nonlethal damage does not count as a kill");
	functions.unit_deal_damage(killed_building, killed_building->hp, marine, 1, false);
	condition.count_n = 1;
	require(functions.test_trigger_condition(condition, 1), "Force 1 receives a lethal building kill");
	condition.unit_id = int(UnitTypes::Terran_Supply_Depot);
	require(functions.test_trigger_condition(condition, 1), "specific killed type is retained");
	functions.unit_deal_damage(killed_building, 1_fp8, marine, 1, false);
	require(functions.test_trigger_condition(condition, 1), "dead target does not award a second kill");
	condition.unit_id = 230;
	condition.count_n = 0;
	require(functions.test_trigger_condition(condition, 1), "building kill is not a Men kill");
	a_vector<unit_t*> killed_units;
	for (unit_t* unit : ptr(st.player_units[4])) if (unit->unit_type->id == UnitTypes::Zerg_Zergling) killed_units.push_back(unit);
	require(killed_units.size() >= 3, "kill-credit isolation fixtures");
	functions.unit_deal_damage(killed_units[0], killed_units[0]->hp, nullptr, 1, false);
	condition.count_n = 1;
	require(functions.test_trigger_condition(condition, 1), "projectile owner receives credit after its source unit is gone");
	condition.unit_id = 229;
	condition.count_n = 2;
	require(functions.test_trigger_condition(condition, 1), "Any Unit combines building and Men kills");
	functions.set_unit_owner(killed_units[1], 1, true);
	functions.unit_deal_damage(killed_units[1], killed_units[1]->hp, marine, 1, false);
	require(functions.test_trigger_condition(condition, 1), "friendly fire awards no enemy kill");
	functions.kill_unit(killed_units[2]);
	functions.unit_deal_damage(killed_units[2], 1_fp8, marine, 1, false);
	require(functions.test_trigger_condition(condition, 1), "scripted death awards no later weapon kill");
	condition.group = 4;
	condition.count_n = 0;
	require(functions.test_trigger_condition(condition, 1), "victim player does not receive kill credit");
	condition.type = 15;
	condition.count_n = 3;
	require(functions.test_trigger_condition(condition, 1), "victim Deaths include enemy and scripted deaths independently of kills");
	functions.kill_unit(killed_units[2]);
	require(functions.test_trigger_condition(condition, 1), "repeated kill of a dying actor does not double-count Deaths");
	condition.unit_id = 231;
	condition.count_n = 1;
	require(functions.test_trigger_condition(condition, 1), "Deaths supports the original Buildings group");
	printf("Campaign credited-kill checks passed.\n");
	trigger::action vision{};
	vision.type = 15;
	for (int player = 0; player != 8; ++player) {
		vision.group2_n = 0x3069562b + (player << 24);
		functions.execute_trigger_action(effects, 1, running, running.actions[0], vision);
		require((st.shared_vision[player] & (1 << 1)) != 0, "legacy shared-vision AI script remains supported");
	}
	printf("Campaign shared-vision script checks passed.\n");
}

static void campaign_outcomes(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	struct scenario_case {
		const char* name;
		int marines;
		bool barracks;
		bool rescue;
		int destroy;
		int minerals;
		int expected;
	};
	const scenario_case scenarios[] = {
		{"nine Marines", 9, true, true, 0, -1, 0},
		{"missing Barracks", 10, false, true, 0, -1, 0},
		{"Raynor not rescued", 10, true, false, 0, -1, 0},
		{"full original victory", 10, true, true, 0, -1, 3},
		{"all human units lost", 5, false, false, 1, -1, 2},
		{"Raynor lost", 5, false, false, 2, -1, 2},
		{"economy loss at 399", 5, false, false, 3, 399, 2},
		{"economy survives at 400", 5, false, false, 3, 400, 0},
	};
	for (const auto& scenario : scenarios) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.victory_condition = 0;
		loader.setup_info.tournament_mode = 0;
		loader.setup_info.starting_units = 0;
		loader.setup_info.resource_type = 0;
		loader.setup_info.starting_minerals = 0;
		loader.setup_info.create_melee_units_for_player = {};
		loader.load_map(map_loader);
		state& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		functions.next_frame();
		functions.next_frame();
		require(st.current_minerals[1] == 40, "original initialization before outcome fixtures");
		unit_t* marine = nullptr;
		unit_t* raynor = nullptr;
		for (unit_t* unit : ptr(st.player_units[1])) if (unit->unit_type->id == UnitTypes::Terran_Marine) marine = unit;
		for (unit_t* unit : ptr(st.player_units[2])) raynor = unit;
		require(marine && raynor, "outcome fixture actors");
		for (int count = 5; count < scenario.marines; ++count) {
			require(functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Marine), marine->sprite->position, 1) != nullptr, "create outcome fixture Marine");
		}
		if (scenario.barracks) {
			bool created = false;
			for (int tile_y = 32; tile_y < 60 && !created; ++tile_y) {
				for (int tile_x = 20; tile_x < 48 && !created; ++tile_x) {
					created = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Barracks), xy(tile_x * 32, tile_y * 32), 1) != nullptr;
				}
			}
			require(created, "create outcome fixture Barracks");
		}
		if (scenario.rescue) {
			xy original = marine->sprite->position;
			functions.move_unit(marine, raynor->sprite->position + xy(48, 0));
			raynor->main_order_timer = 0;
			functions.order_RescuePassive(raynor);
			require(raynor->owner == 1, "outcome requires actual rescue order");
			functions.move_unit(marine, original);
		}
		if (scenario.minerals >= 0) st.current_minerals[1] = scenario.minerals;
		if (scenario.destroy == 2) functions.kill_unit(raynor);
		if (scenario.destroy == 1 || scenario.destroy == 3) {
			a_vector<unit_t*> destroyed;
			for (unit_t* unit : ptr(st.player_units[1])) {
				if (scenario.destroy == 1 || unit->unit_type->id == UnitTypes::Terran_Command_Center) destroyed.push_back(unit);
			}
			for (unit_t* unit : destroyed) functions.kill_unit(unit);
		}
		bool saw_pause = false;
		for (int tick = 0; tick != 1600 && !st.players[1].victory_state; ++tick) {
			functions.next_frame();
			if (st.scripted_pause) saw_pause = true;
		}
		if (st.players[1].victory_state != scenario.expected) error("original mission outcome '%s': expected %d, got %d", scenario.name, scenario.expected, st.players[1].victory_state);
		if (scenario.destroy == 3 && scenario.minerals == 399) require(saw_pause, "original paused economy-defeat dialogue must complete");
		printf("Original mission predicate passed: %s\n", scenario.name);
	}
}

static void backwater_checks(state& st) {
	state_functions functions(st);
	require(count_units(st, 1) == 11 && count_units(st, 2) == 0 && count_units(st, 3) == 7 && count_units(st, 4) == 61 && count_units(st, 11) == 15, "original 94 Backwater actors with natural startup Raynor rescue");
	unit_t* infested_command_center = nullptr;
	for (unit_t* unit : ptr(st.player_units[4])) if (unit->unit_type->id == UnitTypes::Zerg_Infested_Command_Center) infested_command_center = unit;
	require(infested_command_center && int(infested_command_center->unit_type->id) == 130, "Backwater target is the Infested Command Center, not a Hatchery");
	require(infested_command_center->order_type->id == Orders::ComputerAI, "unscripted computer building retains its ComputerAI order");
	functions.order_ComputerAI(infested_command_center);
	require(count_units(st, 4) == 61 && infested_command_center->order_type->id == Orders::ComputerAI, "unscripted building idle does not invent production or replace the order");
	for (int tick = 0; tick != 1200; ++tick) functions.next_frame();
	require(count_units(st, 4) == 61 && infested_command_center->order_type->id == Orders::ComputerAI, "idle original Zerg force does not invent economy or attack waves");
	require(st.current_minerals[1] == 200 && st.current_gas[1] == 200, "original Backwater trigger grants both minerals and gas");
	trigger::condition condition{};
	condition.type = 1;
	condition.num_n = 10;
	condition.count_n = 0;
	require(functions.test_trigger_condition(condition, 1), "original countdown starts at zero");
	st.countdown_timer = 8;
	condition.count_n = 8;
	require(functions.test_trigger_condition(condition, 1), "countdown exact boundary");
	condition.count_n = 7;
	require(!functions.test_trigger_condition(condition, 1), "countdown exact negative boundary");
	st.countdown_timer = 0;
	condition.type = 11;
	condition.extra_n = 0;
	condition.num_n = 3;
	require(functions.test_trigger_condition(condition, 1), "original switch starts clear");
	state_functions::execute_trigger_struct effects;
	running_trigger running;
	trigger::action action{};
	action.type = 13;
	action.group2_n = 0;
	action.num_n = 4;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	require(!functions.test_trigger_condition(condition, 1), "set switch is not cleared");
	condition.num_n = 2;
	require(functions.test_trigger_condition(condition, 1), "set switch condition");
	action.num_n = 6;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	require(!functions.test_trigger_condition(condition, 1), "toggle switch condition");
	action.num_n = 4;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	action.num_n = 5;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	condition.num_n = 3;
	require(functions.test_trigger_condition(condition, 1), "clear switch action");
	printf("Backwater countdown and switch checks passed.\n");
	unit_t* marine = nullptr;
	for (unit_t* unit : ptr(st.player_units[1])) if (unit->unit_type->id == UnitTypes::Terran_Marine) marine = unit;
	require(marine != nullptr, "Backwater Marine fixture");
	unit_t* station = nullptr;
	for (unit_t* unit : ptr(st.player_units[3])) if (unit->unit_type->id == UnitTypes::Terran_Command_Center) station = unit;
	require(station != nullptr, "original rescue station Command Center");
	int original_humans = count_units(st, 1);
	int original_station = count_units(st, 3);
	xy original_position = marine->sprite->position;
	functions.move_unit(marine, station->sprite->position + xy(48, 0));
	station->main_order_timer = 0;
	functions.order_RescuePassive(station);
	require(count_units(st, 3) == 0 && count_units(st, 1) == original_humans + original_station, "station depot rescue transfers the whole rescuable player");
	functions.move_unit(marine, original_position);
	printf("Backwater whole-station rescue check passed.\n");
	const auto& reinforcement = st.game->triggers.at(3).actions[1];
	require(reinforcement.type == 11 && reinforcement.num_n == 0 && reinforcement.group2_n == 0, "original legacy reinforcement encoding");
	int firebats_before = st.unit_counts[3][UnitTypes::Terran_Firebat];
	functions.execute_trigger_action(effects, 1, running, running.actions[0], reinforcement);
	require(st.unit_counts[3][UnitTypes::Terran_Firebat] == firebats_before + 1, "legacy zero-quantity creation yields one original reinforcement");
	auto customized = reinforcement;
	customized.group2_n = 1;
	customized.num_n = 2;
	auto& property_slot = st.game->unit_properties[0];
	property_slot.valid_data_flags = 2;
	property_slot.hitpoints_percent = 50;
	property_slot.valid_state_flags = 16;
	property_slot.state_flags = 16;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], customized);
	require(st.unit_counts[3][UnitTypes::Terran_Firebat] == firebats_before + 3, "explicit creation quantity is preserved");
	int customized_units = 0;
	for (unit_t* unit : ptr(st.player_units[3])) if (unit->unit_type->id == UnitTypes::Terran_Firebat && functions.u_invincible(unit) && unit->hp == unit->unit_type->hitpoints / 2) ++customized_units;
	require(customized_units == 2, "creation applies the selected UPRP hitpoint and invincibility properties");
	property_slot = {};
	st.locations.emplace_back();
	st.locations.back().area = functions.square_at(marine->sprite->position, 1);
	st.locations.back().elevation_flags = 0;
	condition = {};
	condition.type = 3;
	condition.group = 13;
	condition.unit_id = 0;
	condition.num_n = 0;
	condition.count_n = 1;
	condition.location = int(st.locations.size());
	require(functions.test_trigger_condition(condition, 1), "original Bring condition recognizes Marine in location");
	action = {};
	action.type = 43;
	action.location = condition.location;
	action.group_n = 13;
	action.extra_n = 0;
	action.num_n = 4;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	require(functions.u_invincible(marine), "invincibility enable action");
	action.num_n = 6;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	require(!functions.u_invincible(marine), "invincibility toggle action");
	action.num_n = 4;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	action.num_n = 5;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	require(!functions.u_invincible(marine), "invincibility disable action");
	st.locations.back().area = functions.map_bounds();
	action.num_n = 4;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	auto living_marines = [&]() {
		int count = 0;
		for (unit_t* unit : ptr(st.player_units[1])) if (unit->unit_type->id == UnitTypes::Terran_Marine && !functions.unit_dying(unit)) ++count;
		return count;
	};
	int before = living_marines();
	action.type = 23;
	action.num_n = 1;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	require(living_marines() == before - 1, "kill-at-location honors quantity and kills invincible units");
	action.num_n = 0;
	functions.execute_trigger_action(effects, 1, running, running.actions[0], action);
	require(living_marines() == 0, "kill-at-location zero quantity means all matching units");
	printf("Backwater Bring, invincibility and kill-at-location checks passed.\n");
}

static void backwater_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 8; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.victory_condition = 0;
		loader.setup_info.tournament_mode = 0;
		loader.setup_info.starting_units = 0;
		loader.setup_info.resource_type = 0;
		loader.setup_info.starting_minerals = 0;
		loader.setup_info.create_melee_units_for_player = {};
		loader.load_map(map_loader);
		state& st = player.st();
		st.strict_triggers = true;
		struct observed_functions : state_functions {
			using state_functions::state_functions;
			a_vector<trigger::action> events;
			void on_trigger_action(int, const trigger::action& action) override { events.push_back(action); }
		} functions(st);
		unit_t* raynor = nullptr;
		unit_t* marine = nullptr;
		unit_t* station = nullptr;
		unit_t* target = nullptr;
		unit_t* guard = nullptr;
		for (unit_t* unit : ptr(st.player_units[1])) {
			if (unit->unit_type->id == UnitTypes::Hero_Jim_Raynor_Vulture) raynor = unit;
			if (unit->unit_type->id == UnitTypes::Terran_Marine) marine = unit;
		}
		for (unit_t* unit : ptr(st.player_units[3])) if (unit->unit_type->id == UnitTypes::Terran_Command_Center) station = unit;
		for (unit_t* unit : ptr(st.player_units[4])) {
			if (unit->unit_type->id == UnitTypes::Zerg_Infested_Command_Center) target = unit;
			if (unit->unit_type->id == UnitTypes::Zerg_Zergling) guard = unit;
		}
		require(raynor && marine && station && target, "original Backwater mission-case actors");
		if (scenario == 1) {
			functions.move_unit(marine, station->sprite->position + xy(48, 0));
			station->main_order_timer = 0;
			functions.order_RescuePassive(station);
		}
		if (scenario == 2) functions.kill_unit(target);
		if (scenario == 3) functions.kill_unit(raynor);
		if (scenario >= 4 && scenario <= 6) {
			unit_t* speaker = scenario == 6 ? raynor : marine;
			if (scenario == 5) speaker = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Firebat), marine->sprite->position, 1);
			require(speaker != nullptr, "Backwater dialogue speaker fixture");
			const auto& area = st.locations.at(2).area;
			functions.move_unit(speaker, (area.from + area.to) / 2);
			functions.u_set_status_flag(speaker, unit_t::status_flag_invincible);
			functions.u_set_status_flag(target, unit_t::status_flag_invincible);
		}
		if (scenario == 7) {
			require(guard != nullptr, "original defending Zergling");
			functions.move_unit(marine, guard->sprite->position + xy(24, 0));
			functions.u_set_status_flag(guard, unit_t::status_flag_invincible);
		}
		bool paused = false;
		bool guard_engaged = false;
		for (int tick = 0; tick != 4000 && !st.players[1].victory_state; ++tick) {
			if (scenario == 1) {
				for (int owner : {1, 3}) for (unit_t* unit : ptr(st.player_units[owner])) functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
			}
			functions.next_frame();
			if (scenario == 7 && guard->order_target.unit == marine) guard_engaged = true;
			if (st.scripted_pause) paused = true;
		}
		if (scenario == 0) require(!st.players[1].victory_state && count_units(st, 4) == 61, "idle Backwater cannot invent victory, production or attack waves");
		if (scenario == 1) {
			require(!st.players[1].victory_state, "rescuing the station alone must not win");
			require(st.unit_counts[1][UnitTypes::Terran_Firebat] == 5 && st.unit_counts[1][UnitTypes::Terran_SCV] == 4, "original bunker and station triggers deliver five Firebats and two additional SCVs");
		}
		if (scenario == 2) {
			require(st.players[1].victory_state >= 3 && paused, "destroying the original infested Command Center completes its paused victory sequence");
			int transmissions = 0;
			for (const auto& event : functions.events) if (event.type == 7) ++transmissions;
			require(transmissions >= 5, "original ending transmissions run before victory");
		}
		if (scenario == 3) require(st.players[1].victory_state == 2 && paused, "original Raynor-loss sequence reaches paused defeat");
		if (scenario >= 4 && scenario <= 6) {
			bool marine_dialogue = false;
			bool firebat_dialogue = false;
			for (const auto& event : functions.events) {
				if (event.type == 7 && event.string_index == 29) marine_dialogue = true;
				if (event.type == 7 && event.string_index == 30) firebat_dialogue = true;
			}
			require(!st.players[1].victory_state, "approaching the infested building alone must not win");
			require(marine_dialogue == (scenario == 4) && firebat_dialogue == (scenario == 5), "original Marine/Firebat dialogue branches and Raynor-only exclusion");
			require(st.unit_counts[1][(UnitTypes)101] == 0, "temporary dialogue map revealer is removed by its original kill-at-location action");
		}
		if (scenario == 7) require(guard_engaged && !st.players[1].victory_state, "placed Zerg guard engages an approaching player unit without inventing victory");
		printf("Backwater original mission case %d passed.\n", scenario);
	}
}

static void desperate_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 13; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.victory_condition = 0;
		loader.setup_info.tournament_mode = 0;
		loader.setup_info.starting_units = 0;
		loader.setup_info.resource_type = 0;
		loader.setup_info.starting_minerals = 0;
		loader.setup_info.create_melee_units_for_player = {};
		loader.load_map(map_loader);
		state& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (int tick = 0; tick != 650; ++tick) player.next_frame();
		require(st.trigger_switches[0] && !st.trigger_switches[1] && !st.players[1].victory_state, "original timer switch initialization and no early outcome");
		if (scenario == 5) {
			a_vector<unit_t*> marines;
			a_vector<unit_t*> zerglings;
			for (unit_t* unit : ptr(st.player_units[1])) if (unit->unit_type->id == UnitTypes::Terran_Marine) marines.push_back(unit);
			for (unit_t* unit : ptr(st.player_units[4])) if (unit->unit_type->id == UnitTypes::Zerg_Zergling) zerglings.push_back(unit);
			require(marines.size() >= 2 && zerglings.size() >= 2, "attack coordination fixture actors");
			functions.move_unit(zerglings[0], marines.front()->sprite->position + xy(16, 0));
			functions.move_unit(zerglings[1], marines.back()->sprite->position + xy(16, 0));
			st.campaign_ai[4].attack_party = {functions.get_unit_id(zerglings[0]), functions.get_unit_id(zerglings[1])};
			functions.launch_campaign_ai_attack(4);
			require(zerglings[0]->order_type->id == Orders::AttackMove && zerglings[1]->order_type->id == Orders::AttackMove, "party uses native attack-move orders");
			require(zerglings[0]->order_target.pos == zerglings[1]->order_target.pos, "one military party shares its strategic attack destination");
			printf("Desperate Alliance shared attack destination passed.\n");
			continue;
		}
		if (scenario == 6) {
			unit_t* ground = nullptr;
			unit_t* air = nullptr;
			for (unit_t* unit : ptr(st.player_units[1])) if (unit->unit_type->id == UnitTypes::Terran_Marine) ground = unit;
			for (unit_t* unit : ptr(st.player_units[4])) if (unit->unit_type->id == UnitTypes::Zerg_Overlord) air = unit;
			require(ground && air, "regional defense classification actors");
			functions.move_unit(air, ground->sprite->position);
			require(functions.campaign_ai_defense_category(ground) == 0 && functions.campaign_ai_defense_category(air) == 1, "GG and AG apply to pathable regions");
			bool found = false;
			for (int vertical = 80; vertical < int(st.game->map_height) - 64 && !found; vertical += 32) {
				for (int horizontal = 80; horizontal < int(st.game->map_width) - 64 && !found; horizontal += 32) {
					xy pos(horizontal, vertical);
					if (functions.get_region_at(pos)->walkable()) continue;
					functions.move_unit(ground, pos);
					functions.move_unit(air, pos);
					require(ground->sprite->position == pos && air->sprite->position == pos, "classification fixture is not displaced by unit map bounds");
					require(functions.campaign_ai_defense_category(ground) == 2 && functions.campaign_ai_defense_category(air) == 3, "GA and AA apply to unpathable regions");
					found = true;
				}
			}
			require(found, "original map supplies an unpathable region fixture");
			printf("Desperate Alliance regional defense categories passed.\n");
			continue;
		}
		if (scenario == 7) {
			unit_t* hatchery = nullptr;
			unit_t* den = nullptr;
			a_vector<unit_t*> marines;
			for (unit_t* unit : ptr(st.player_units[4])) {
				if (unit->unit_type->id == UnitTypes::Zerg_Hatchery) hatchery = unit;
				if (unit->unit_type->id == UnitTypes::Zerg_Hydralisk_Den) den = unit;
			}
			for (unit_t* unit : ptr(st.player_units[1])) if (unit->unit_type->id == UnitTypes::Terran_Marine) marines.push_back(unit);
			require(hatchery && den && marines.size() >= 3, "regional strength fixture actors");
			xy remote = marines.back()->sprite->position;
			functions.move_unit(den, remote);
			functions.move_unit(marines[0], hatchery->sprite->position);
			functions.move_unit(marines[1], hatchery->sprite->position);
			functions.move_unit(marines[2], remote);
			auto& ai = st.campaign_ai[4];
			ai.maximum_force = 1;
			functions.update_campaign_ai_regions(4);
			size_t home_region = functions.get_region_at(hatchery->sprite->position)->index;
			size_t remote_region = functions.get_region_at(remote)->index;
			require(home_region != remote_region, "independent regional incursion fixtures");
			for (size_t region : {home_region, remote_region}) {
				require(ai.regions[region].owned && ai.regions[region].defended, "primary buildings establish regional defense");
				require(ai.regions[region].needed[0] == 1 && ai.regions[region].needed[1] == 1, "max_force caps ground and air demand independently per region");
			}
			ai.maximum_force = 0;
			functions.update_campaign_ai_regions(4);
			require(ai.regions[home_region].needed[0] >= 2 * st.game->unit_ground_strength[UnitTypes::Terran_Marine], "regional demand aggregates enemy base strengths");
			ai.maximum_force = 1;
			ai.attack_preparing = true;
			ai.attack_deadline = st.current_frame + 2700;
			ai.attack_requests[UnitTypes::Zerg_Hydralisk] = 15;
			st.current_frame = (st.current_frame + 7) / 8 * 8;
			functions.progress_campaign_ai_town(4);
			bool home_defended = false;
			bool remote_defended = false;
			a_vector<unit_id> assigned;
			for (const auto& defender : ai.defending) {
				require(std::find(assigned.begin(), assigned.end(), defender.unit) == assigned.end(), "one defender cannot be allocated to two regions");
				require(std::find(ai.attack_party.begin(), ai.attack_party.end(), defender.unit) == ai.attack_party.end(), "active regional defenders are not stolen by attack recruitment");
				assigned.push_back(defender.unit);
				if (defender.region == home_region) home_defended = true;
				if (defender.region == remote_region) remote_defended = true;
			}
			require(home_defended && remote_defended, "simultaneous incursions get independent actual defenders");
			auto defenders = ai.defending;
			ai.attack_preparing = false;
			ai.attack_party.clear();
			ai.attack_requests = {};
			for (unit_t* unit : ptr(st.player_units[1])) functions.kill_unit(unit);
			functions.progress_campaign_ai_town(4);
			require(ai.defending.empty(), "cleared regions release their defender assignments");
			for (const auto& defender : defenders) {
				unit_t* unit = functions.get_unit(defender.unit);
				require(unit && unit->order_type->id == Orders::AttackMove && unit->order_target.pos == defender.home, "released defenders return toward their prior positions");
			}
			printf("Desperate Alliance independent regional strength budgets passed.\n");
			continue;
		}
		if (scenario == 8) {
			unit_t* command_center = nullptr;
			unit_t* zergling = nullptr;
			unit_t* mutalisk = nullptr;
			for (unit_t* unit : ptr(st.player_units[1])) if (unit->unit_type->id == UnitTypes::Terran_Command_Center) command_center = unit;
			for (unit_t* unit : ptr(st.player_units[4])) {
				if (unit->unit_type->id == UnitTypes::Zerg_Zergling) zergling = unit;
				if (unit->unit_type->id == UnitTypes::Zerg_Mutalisk) mutalisk = unit;
			}
			require(command_center && zergling && mutalisk, "mixed military party fixture actors");
			for (unit_t* unit : ptr(st.player_units[1])) if (unit != command_center) functions.kill_unit(unit);
			functions.order_BuildingLiftoff(command_center);
			require(functions.u_flying(command_center), "original Command Center lifts through native order logic");
			st.campaign_ai[4].attack_party = {functions.get_unit_id(zergling), functions.get_unit_id(mutalisk)};
			functions.launch_campaign_ai_attack(4);
			require(mutalisk->order_type->id == Orders::AttackMove && mutalisk->order_target.pos == command_center->sprite->position, "ground leader cannot prevent an air-capable party member attacking a lifted building");
			printf("Desperate Alliance mixed-party air capability passed.\n");
			continue;
		}
		if (scenario == 9) {
			unit_t* marine = nullptr;
			unit_t* zergling = nullptr;
			for (unit_t* unit : ptr(st.player_units[1])) if (unit->unit_type->id == UnitTypes::Terran_Marine) marine = unit;
			for (unit_t* unit : ptr(st.player_units[4])) if (unit->unit_type->id == UnitTypes::Zerg_Zergling) zergling = unit;
			require(marine && zergling, "engaged guard recruitment fixture actors");
			functions.move_unit(zergling, marine->sprite->position + xy(16, 0));
			functions.issue_order(zergling, false, zergling->unit_type->attack_unit, {marine->sprite->position, marine});
			auto& ai = st.campaign_ai[4];
			ai.home = zergling->sprite->position;
			ai.attack_requests[UnitTypes::Zerg_Zergling] = 1;
			ai.attack_preparing = true;
			ai.attack_deadline = st.current_frame + 2700;
			st.current_frame = (st.current_frame + 7) / 8 * 8;
			functions.progress_campaign_ai_town(4);
			require(std::find(ai.attack_party.begin(), ai.attack_party.end(), functions.get_unit_id(zergling)) == ai.attack_party.end(), "attack recruitment does not interrupt an engaged guard");
			require(zergling->order_target.unit == marine, "engaged guard keeps its combat target");
			printf("Desperate Alliance engaged-guard recruitment exclusion passed.\n");
			continue;
		}
		if (scenario == 10) {
			a_vector<unit_t*> zerglings;
			for (unit_t* unit : ptr(st.player_units[4])) if (unit->unit_type->id == UnitTypes::Zerg_Zergling) zerglings.push_back(unit);
			require(zerglings.size() >= 2, "regional grouping fixture actors");
			bool found = false;
			for (int vertical = 80; vertical < int(st.game->map_height) - 80 && !found; vertical += 16) {
				for (int horizontal = 80; horizontal < int(st.game->map_width) - 80 && !found; horizontal += 16) {
					xy home(horizontal, vertical);
					xy nearby = home + xy(16, 0);
					const auto* first = functions.get_region_at(home);
					const auto* second = functions.get_region_at(nearby);
					if (first == second || !first->walkable() || !second->walkable()) continue;
					st.campaign_ai[4].home = home;
					st.campaign_ai[4].attack_party = {functions.get_unit_id(zerglings[0]), functions.get_unit_id(zerglings[1])};
					functions.move_unit(zerglings[0], home);
					functions.move_unit(zerglings[1], nearby);
					if (functions.get_region_at(zerglings[0]->sprite->position) != first || functions.get_region_at(zerglings[1]->sprite->position) != second) continue;
					require(!functions.campaign_ai_party_grouped(4), "nearby units in different pathing regions have not finished grouping");
					functions.move_unit(zerglings[1], home);
					require(functions.campaign_ai_party_grouped(4), "party is ready when both members reach the grouping region");
					found = true;
				}
			}
			require(found, "original map supplies a walkable region boundary");
			printf("Desperate Alliance pathing-region attack grouping passed.\n");
			continue;
		}
		if (scenario == 11) {
			a_vector<unit_t*> zerglings;
			for (unit_t* unit : ptr(st.player_units[4])) if (unit->unit_type->id == UnitTypes::Zerg_Zergling) zerglings.push_back(unit);
			require(zerglings.size() >= 2, "continuing military fixture actors");
			auto& ai = st.campaign_ai[4];
			ai.attack_party = {functions.get_unit_id(zerglings[0]), functions.get_unit_id(zerglings[1])};
			functions.launch_campaign_ai_attack(4);
			unit_t* old_target = functions.get_unit(ai.military_target);
			require(old_target && ai.attacking.size() == 2, "military party has an initial shared target");
			functions.kill_unit(old_target);
			functions.move_unit(zerglings[0], old_target->sprite->position);
			unit_t* distant_target = nullptr;
			for (unit_t* unit : ptr(st.player_units[1])) {
				if (functions.unit_dying(unit)) continue;
				if (!functions.unit_target_in_weapon_movement_range(zerglings[0], unit)) { distant_target = unit; break; }
			}
			require(distant_target != nullptr, "continuing military has an out-of-range living enemy fixture");
			for (int member = 0; member != 2; ++member) {
				functions.move_unit(zerglings[member], old_target->sprite->position);
				functions.set_unit_order(zerglings[member], functions.get_order_type(Orders::PlayerGuard));
				zerglings[member]->auto_target_unit = distant_target;
				require(!functions.unit_target_in_weapon_movement_range(zerglings[member], distant_target), "remembered target is outside actual combat range");
			}
			st.current_frame = (st.current_frame + 7) / 8 * 8;
			functions.progress_campaign_ai_town(4);
			unit_t* target = functions.get_unit(ai.military_target);
			require(target && target != old_target && !functions.unit_dying(target), "military chooses a new live target after a cleared destination");
			for (int member = 0; member != 2; ++member) require(zerglings[member]->order_type->id == Orders::AttackMove && zerglings[member]->order_target.pos == target->sprite->position, "surviving idle attackers continue together rather than parking at the old destination");
			functions.move_unit(zerglings[1], target->sprite->position + xy(16, 0));
			functions.set_unit_order(zerglings[1], functions.get_order_type(Orders::PlayerGuard));
			zerglings[1]->auto_target_unit = target;
			functions.set_sprite_visibility(target->sprite, 0xff);
			require(functions.unit_can_attack_target(zerglings[1], target) && functions.unit_target_in_weapon_movement_range(zerglings[1], target), "continuing military has an active in-range combat fixture");
			functions.progress_campaign_ai_town(4);
			require(zerglings[1]->order_type->id == Orders::PlayerGuard && zerglings[1]->auto_target_unit == target, "continuation preserves valid in-range native combat");
			printf("Desperate Alliance continuing military retargeting passed.\n");
			continue;
		}
		if (scenario == 12) {
			bool combat = false;
			int first_combat = 0;
			for (int tick = 0; tick != 32000 && !st.players[1].victory_state; ++tick) {
				player.next_frame();
				for (unit_id id : st.campaign_ai[4].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || !unit->order_target.unit || unit->order_target.unit->owner != 1) continue;
					if (unit->ground_weapon_cooldown || unit->air_weapon_cooldown) {
						if (!combat) first_combat = st.current_frame;
						combat = true;
					}
				}
			}
			require(combat, "unprotected original mission receives real weapon fire from deployed scripted attacks");
			printf("Desperate Alliance unassisted diagnostic: first combat frame=%d, outcome=%d, frame=%d, human actors=%d.\n", first_combat, st.players[1].victory_state, st.current_frame, count_units(st, 1));
			continue;
		}
		if (scenario == 0) st.countdown_timer = 10;
		if (scenario == 1) { st.trigger_switches[0] = false; st.countdown_timer = 0; }
		if (scenario == 2) {
			for (unit_t* unit : ptr(st.player_units[1])) if (unit->unit_type->group_flags & GroupFlags::Building) functions.kill_unit(unit);
		}
		if (scenario == 3) st.countdown_timer = 120;
		if (scenario != 2) for (unit_t* unit : ptr(st.player_units[1])) functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
		bool paused = false;
		bool final_assault = false;
		bool air_attack = false;
		for (int tick = 0; tick != (scenario == 4 ? 32000 : 3500) && !st.players[1].victory_state; ++tick) {
			player.next_frame();
			paused = paused || st.scripted_pause;
			if (st.campaign_ai[4].attacking.size() >= 20) final_assault = true;
			for (unit_id id : st.campaign_ai[4].attacking) {
				unit_t* unit = functions.get_unit(id);
				if (unit && unit->unit_type->id == UnitTypes::Zerg_Mutalisk) air_attack = true;
			}
		}
		if (scenario == 0 || scenario == 3 || scenario == 4) require(st.players[1].victory_state >= 3 && paused, "original survival ending reaches paused victory");
		if (scenario == 1) require(!st.players[1].victory_state, "zero countdown without initialization switch does not win");
		if (scenario == 2) require(st.players[1].victory_state == 2, "original all-buildings-lost defeat");
		if (scenario == 3) require(final_assault, "original two-minute trigger sends real remaining military units");
		if (scenario == 4) require(air_attack && st.current_frame >= 1800 * 16, "full original countdown and later script-driven Mutalisk attacks");
		printf("Desperate Alliance original mission case %d passed.\n", scenario);
	}
}

static void jacobs_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 7; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.victory_condition = 0;
		loader.setup_info.tournament_mode = 0;
		loader.setup_info.starting_units = 0;
		loader.setup_info.resource_type = 0;
		loader.setup_info.starting_minerals = 0;
		loader.setup_info.create_melee_units_for_player = {};
		loader.load_map(map_loader);
		state& st = player.st();
		st.strict_triggers = true;
		struct observed_functions : state_functions {
			using state_functions::state_functions;
			a_vector<trigger::action> events;
			a_vector<std::pair<xy, xy>> camera_positions;
			void on_trigger_action(int, const trigger::action& action) override {
				events.push_back(action);
				if (action.type == 10 && action.location == 30) {
					const auto& area = st.locations.at(action.location - 1).area;
					for (unit_t* unit : ptr(st.player_units[0])) if (unit->unit_type->id == UnitTypes::Hero_Jim_Raynor_Marine) camera_positions.emplace_back((area.from + area.to) / 2, unit->sprite->position);
				}
			}
		} functions(st);
		unit_t* marine = nullptr;
		unit_t* raynor = nullptr;
		for (unit_t* unit : ptr(st.player_units[0])) if (unit->unit_type->id == UnitTypes::Terran_Marine) marine = unit;
		for (int owner : {0, 2}) for (unit_t* unit : ptr(st.player_units[owner])) if (unit->unit_type->id == UnitTypes::Hero_Jim_Raynor_Marine) raynor = unit;
		require(marine && raynor, "original Jacobs Marine squad and rescuable Marine Raynor");
		if (scenario == 5) {
			unit_t* trap = nullptr;
			for (int owner = 0; owner != 12; ++owner) for (unit_t* unit : ptr(st.player_units[owner])) {
				if (unit->unit_type->id == UnitTypes::Special_Floor_Gun_Trap && functions.u_disabled(unit)) trap = unit;
			}
			require(trap != nullptr, "original disabled floor gun trap");
			xy previous_position = marine->sprite->position;
			functions.move_unit(marine, trap->sprite->position + xy(48, 0));
			functions.set_unit_order(marine, functions.get_order_type(Orders::HoldPosition));
			functions.u_set_status_flag(trap, unit_t::status_flag_invincible);
			auto previous_hp = marine->hp;
			for (int tick = 0; tick != 120; ++tick) {
				functions.set_sprite_visibility(marine->sprite, 0xff);
				functions.next_frame();
			}
			require(marine->hp == previous_hp && functions.u_disabled(trap) && trap->order_type->id == Orders::HiddenGun, "disabled floor trap cannot attack an adjacent visible enemy");
			functions.set_doodad_state(trap, true);
			for (int tick = 0; tick != 240 && marine->hp == previous_hp; ++tick) {
				functions.set_sprite_visibility(marine->sprite, 0xff);
				functions.next_frame();
			}
			require(marine->hp < previous_hp && !functions.u_disabled(trap), "enabled floor trap reveals and fires its native weapon");
			functions.move_unit(marine, previous_position);
			functions.set_unit_order(marine, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 240; ++tick) functions.next_frame();
			require(trap->order_type->id == Orders::HiddenGun && functions.u_no_collide(trap) && functions.u_cloaked(trap), "unoccupied floor trap completes its hiding animation and becomes concealed again");
			functions.u_set_status_flag(trap, unit_t::status_flag_iscript_nobrk);
			functions.set_doodad_state(trap, false);
			bool pending_disable = false;
			for (const auto& order : trap->order_queue) if (order.order_type->id == Orders::DisableDoodad) pending_disable = true;
			require(pending_disable && !functions.u_disabled(trap), "security shutdown queues behind a non-interruptible firing animation instead of being lost");
			functions.u_unset_status_flag(trap, unit_t::status_flag_iscript_nobrk);
			functions.activate_next_order(trap);
			for (int tick = 0; tick != 240; ++tick) functions.next_frame();
			require(functions.u_disabled(trap) && trap->order_type->id == Orders::HiddenGun && functions.u_no_collide(trap) && functions.u_cloaked(trap), "deferred security shutdown finishes and leaves the trap disabled and concealed");
			functions.u_set_status_flag(trap, unit_t::status_flag_iscript_nobrk);
			functions.set_doodad_state(trap, true);
			functions.u_unset_status_flag(trap, unit_t::status_flag_iscript_nobrk);
			functions.activate_next_order(trap);
			for (int tick = 0; tick != 120; ++tick) functions.next_frame();
			require(!functions.u_disabled(trap) && trap->order_type->id == Orders::HiddenGun, "queued re-enable progresses through the disabled-unit guard");
			printf("Jacobs Installation original trap lifecycle passed.\n");
			continue;
		}
		if (scenario == 1 || scenario == 2) {
			xy previous_position = marine->sprite->position;
			functions.move_unit(marine, raynor->sprite->position + xy(48, 0));
			raynor->main_order_timer = 0;
			functions.order_RescuePassive(raynor);
			require(raynor->owner == 0, "native proximity rescues Jacobs Marine Raynor");
			functions.move_unit(marine, previous_position);
		}
		if (scenario == 1 || scenario == 4) {
			for (unit_t* unit : ptr(st.player_units[0])) functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
			const auto& area = st.locations.at(scenario == 1 ? 19 : 6).area;
			functions.move_unit(marine, (area.from + area.to) / 2);
			functions.set_unit_order(marine, functions.get_order_type(Orders::HoldPosition));
			if (scenario == 1) {
				functions.move_unit(raynor, (area.from + area.to) / 2 + xy(48, 0));
				functions.set_unit_order(raynor, functions.get_order_type(Orders::HoldPosition));
			}
		}
		if (scenario == 6) {
			const auto& area = st.locations.at(7).area;
			functions.move_unit(raynor, (area.from + area.to) / 2);
			functions.u_set_status_flag(raynor, unit_t::status_flag_invincible);
			functions.set_unit_order(raynor, functions.get_order_type(Orders::HoldPosition));
			a_vector<unit_t*> zerg;
			for (unit_t* unit : ptr(st.player_units[3])) zerg.push_back(unit);
			for (unit_t* unit : zerg) functions.kill_unit(unit);
		}
		if (scenario == 2) functions.kill_unit(raynor);
		if (scenario == 3) {
			a_vector<unit_t*> units;
			for (unit_t* unit : ptr(st.player_units[0])) units.push_back(unit);
			for (unit_t* unit : units) functions.kill_unit(unit);
		}
		bool paused = false;
		bool teleported = false;
		for (int tick = 0; tick != 4000 && !st.players[0].victory_state; ++tick) {
			functions.next_frame();
			if (st.scripted_pause) paused = true;
			if (scenario == 4) {
				const auto& destination = st.locations.at(7).area;
				if (functions.xy_length(marine->sprite->position - (destination.from + destination.to) / 2) < 128) {
					teleported = true;
					break;
				}
			}
		}
		if (scenario == 0) require(!st.players[0].victory_state && !st.current_minerals[0] && !st.current_gas[0] && st.campaign_ai_scripts.empty(), "idle installation preserves no economy, no invented AI and no outcome");
		if (scenario == 1) {
			require(st.players[0].victory_state >= 3 && paused && st.trigger_switches[4], "original data terminal sequence sets its authored switch and reaches victory");
			require(!functions.camera_positions.empty() && functions.camera_positions.back().first == functions.camera_positions.back().second, "original disk victory centers on Raynor at the data room, not the starting point");
			int transmissions = 0;
			for (const auto& event : functions.events) if (event.type == 7) ++transmissions;
			require(transmissions != 0, "original data retrieval ending retains its transmissions");
		}
		if (scenario == 2) require(st.players[0].victory_state == 2, "original Marine Raynor-loss predicate reaches defeat");
		if (scenario == 3) require(st.players[0].victory_state == 2, "original whole-squad loss predicate reaches defeat");
		if (scenario == 4) {
			require(!st.players[0].victory_state && teleported, "original Bring-triggered teleporter moves the actor without inventing victory");
		}
		if (scenario == 6) {
			bool zerg_dialogue = false;
			for (const auto& event : functions.events) if (event.type == 7 && event.string_index == 31) zerg_dialogue = true;
			require(zerg_dialogue && paused && !st.players[0].victory_state, "killing the original Zerg force triggers its authored encounter dialogue without victory");
			require(!functions.camera_positions.empty() && functions.camera_positions.back().first == functions.camera_positions.back().second, "original Zerg encounter centers on Raynor away from the starting point");
		}
		printf("Jacobs Installation original mission case %d passed.\n", scenario);
	}
}

static void activate_revolution_towns(state& st, state_functions& functions) {
	require(!st.trigger_switches[6], "ground rescue does not activate the original air-only computer location");
	unit_t* scout = nullptr;
	for (unit_t* unit : ptr(st.player_units[0])) if (unit->unit_type->id == UnitTypes::Terran_Wraith) scout = unit;
	require(scout != nullptr, "original rescued Wraith for authored computer activation");
	functions.u_set_status_flag(scout, unit_t::status_flag_invincible);
	xy home = scout->sprite->position;
	const auto& activation = st.locations.at(17).area;
	functions.set_unit_order(scout, functions.get_order_type(Orders::Move), (activation.from + activation.to) / 2);
	for (int tick = 0; tick != 1200 && !st.trigger_switches[6]; ++tick) functions.next_frame();
	require(st.trigger_switches[6], "native flight activates the original Confederate town scripts");
	functions.set_unit_order(scout, functions.get_order_type(Orders::Move), home);
	for (int tick = 0; tick != 4000; ++tick) functions.next_frame();
}

static void revolution_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 8; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.victory_condition = 0;
		loader.setup_info.tournament_mode = 0;
		loader.setup_info.starting_units = 0;
		loader.setup_info.resource_type = 0;
		loader.setup_info.starting_minerals = 0;
		loader.setup_info.create_melee_units_for_player = {};
		loader.load_map(map_loader);
		state& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (int tick = 0; tick != 32; ++tick) functions.next_frame();
		require(st.current_minerals[0] == 300 && st.current_gas[0] == 300, "original Revolution trigger grants 300 minerals and gas");
		require(!functions.player_has_researched(0, TechTypes::Stim_Packs) && !functions.player_has_researched(3, TechTypes::Stim_Packs) && functions.player_has_researched(6, TechTypes::Stim_Packs), "original Revolution starts human and Antigan Stim unresearched, with Confederate Stim researched");
		unit_t* kerrigan = nullptr;
		unit_t* raynor = nullptr;
		for (int owner : {0, 2}) for (unit_t* unit : ptr(st.player_units[owner])) {
			if (unit->unit_type->id == UnitTypes::Hero_Sarah_Kerrigan) kerrigan = unit;
			if (unit->unit_type->id == UnitTypes::Hero_Jim_Raynor_Vulture) raynor = unit;
		}
		require(kerrigan && raynor, "original Revolution hero actors");
		if (scenario >= 6) {
			unit_t* marine = nullptr;
			for (unit_t* unit : ptr(st.player_units[0])) {
				functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
				if (unit->unit_type->id == UnitTypes::Terran_Marine) marine = unit;
			}
			functions.move_unit(marine, kerrigan->sprite->position + xy(48, 0));
			kerrigan->main_order_timer = 0;
			functions.order_RescuePassive(kerrigan);
			functions.u_set_status_flag(kerrigan, unit_t::status_flag_invincible);
			const auto& beacon = st.locations.at(0).area;
			functions.move_unit(kerrigan, (beacon.from + beacon.to) / 2);
			functions.set_unit_order(kerrigan, functions.get_order_type(Orders::HoldPosition));
			auto protected_step = [&]() {
				if (scenario == 7) for (int owner : {0, 3, 6}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					if (functions.ut_building(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				if (scenario == 6) for (unit_t* unit : ptr(st.player_units[6])) if (functions.ut_building(unit) && !functions.unit_dying(unit)) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
			};
			for (int tick = 0; tick != 4000; ++tick) protected_step();
			require(st.unit_counts[0][UnitTypes::Terran_Command_Center] == 1, "original base rescue supplies the Wraith for satellite activation");
			if (scenario == 7) {
				unit_t* bunkers[2] = {};
				for (int owner : {0, 6}) for (unit_t* unit : ptr(st.player_units[owner])) if (functions.unit_is(unit, UnitTypes::Terran_Bunker) && unit->sprite->position == (owner ? xy(2544, 768) : xy(2608, 608))) bunkers[owner ? 1 : 0] = unit;
				require(bunkers[0] && bunkers[1], "the original opposing Revolution cliff bunkers survive native base rescue");
				require(functions.get_ground_height_at(bunkers[0]->sprite->position) > functions.get_ground_height_at(bunkers[1]->sprite->position), "the original rescued bunker stands above its opposing Confederate bunker");
				bool fired[2] = {};
				bool damaged[2] = {};
				bool ready = true;
				for (int index = 0; index != 2; ++index) {
					int loaded = 0;
					for (unit_t* unit : functions.loaded_units(bunkers[index])) {
						++loaded;
						ready = ready && unit->order_type->id == Orders::BunkerGuard && unit->owner == (index ? 6 : 0);
					}
					require(loaded > 0, "both original cliff bunkers retain their script-loaded original garrisons");
				}
				for (int tick = 0; tick != 1024 && !(fired[0] && fired[1] && damaged[0] && damaged[1]); ++tick) {
					protected_step();
					for (int index = 0; index != 2; ++index) {
						if (bunkers[index]->hp < bunkers[index]->unit_type->hitpoints) damaged[index] = true;
						for (unit_t* unit : functions.loaded_units(bunkers[index])) if (unit->ground_weapon_cooldown && unit->order_target.unit == bunkers[1 - index]) fired[index] = true;
					}
				}
				require(ready && fired[0] && fired[1] && damaged[0] && damaged[1], "rescued original bunker garrisons fire at and damage opposing bunkers across the cliff without unloading or reloading");
				require(!functions.player_has_researched(0, TechTypes::Stim_Packs), "base rescue does not invent Stim research for the original human Marines");
				printf("Revolution original cliff garrisons and Stim research passed.\n");
				continue;
			}
			activate_revolution_towns(st, functions);
			unit_t* command_center = nullptr;
			for (unit_t* unit : ptr(st.player_units[6])) if (unit->unit_type->id == UnitTypes::Terran_Command_Center && functions.campaign_ai_unit_town(6, unit) == 1) command_center = unit;
			require(command_center != nullptr, "original Confederate satellite Command Center");
			functions.kill_unit(command_center);
			bool rebuilt = false;
			for (int tick = 0; tick != 6000 && !rebuilt; ++tick) {
				functions.next_frame();
				for (unit_t* unit : ptr(st.player_units[6])) if (unit->unit_type->id == UnitTypes::Terran_Command_Center && !functions.unit_dying(unit) && functions.u_completed(unit) && functions.campaign_ai_unit_town(6, unit) == 1) rebuilt = true;
			}
			require(rebuilt && !st.players[0].victory_state, "Te5H replaces its lost Command Center through a local SCV without inventing victory");
			printf("Revolution original satellite reconstruction passed.\n");
			continue;
		}
		if (scenario == 5) {
			a_vector<unit_t*> wraiths;
			for (unit_t* unit : ptr(st.player_units[6])) if (unit->unit_type->id == UnitTypes::Terran_Wraith) wraiths.push_back(unit);
			require(wraiths.size() >= 2, "original Confederate aircraft for location-scoped combat clearing");
			unit_id inside = functions.get_unit_id(wraiths[0]);
			unit_id outside = functions.get_unit_id(wraiths[1]);
			auto& ai = st.campaign_ai[6];
			ai.attacking = {inside, outside};
			ai.attack_party = {inside, outside};
			functions.start_campaign_ai_script(6, 1131572291, functions.square_at(wraiths[0]->sprite->position, 1));
			functions.progress_campaign_ai_scripts();
			require(ai.attacking.size() == 1 && ai.attacking[0] == outside && ai.attack_party.size() == 1 && ai.attack_party[0] == outside, "ClrC clears only military assignments inside its original script location");
			printf("Revolution location-scoped clear combat passed.\n");
			continue;
		}
		if (scenario == 1) functions.kill_unit(kerrigan);
		if (scenario == 2) functions.kill_unit(raynor);
		if (scenario == 3 || scenario == 4) {
			a_vector<unit_t*> units;
			for (unit_t* unit : ptr(st.player_units[scenario == 3 ? 0 : 6])) {
				if (scenario == 3 || functions.ut_building(unit)) units.push_back(unit);
			}
			for (unit_t* unit : units) functions.kill_unit(unit);
		}
		for (int tick = 0; tick != 3000 && !st.players[0].victory_state; ++tick) functions.next_frame();
		if (scenario == 0) require(!st.players[0].victory_state && st.unit_counts[0][UnitTypes::Terran_Marine] == 8 && st.unit_counts[3][UnitTypes::Terran_Command_Center] == 1, "idle original Revolution does not grant the base or invent an outcome");
		if (scenario >= 1 && scenario <= 3) require(st.players[0].victory_state == 2, "original Revolution hero/squad loss predicate reaches defeat");
		if (scenario == 4) require(st.players[0].victory_state >= 3, "destroying every original Confederate building reaches the authored victory");
		printf("Revolution original mission case %d passed.\n", scenario);
	}
}

static void norad_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 9; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.victory_condition = 0;
		loader.setup_info.tournament_mode = 0;
		loader.setup_info.starting_units = 0;
		loader.setup_info.resource_type = 0;
		loader.setup_info.starting_minerals = 0;
		loader.setup_info.create_melee_units_for_player = {};
		loader.load_map(map_loader);
		state& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		unit_t* raynor = nullptr;
		unit_t* flagship = nullptr;
		for (int owner : {0, 2}) for (unit_t* unit : ptr(st.player_units[owner])) {
			if (unit->unit_type->id == UnitTypes::Hero_Jim_Raynor_Vulture) raynor = unit;
			if (unit->unit_type->id == UnitTypes::Special_Crashed_Norad_II) flagship = unit;
		}
		require(raynor && flagship, "original Norad II Raynor and crashed flagship actors");
		if (scenario == 8) {
			functions.u_set_status_flag(flagship, unit_t::status_flag_invincible);
			for (int tick = 0; tick != 32; ++tick) functions.next_frame();
			unit_t* worker = nullptr;
			for (unit_t* unit : ptr(st.player_units[0])) if (unit->unit_type->id == UnitTypes::Terran_SCV) worker = unit;
			require(worker != nullptr, "original SCV for flagship rescue and repair");
			functions.u_set_status_flag(worker, unit_t::status_flag_invincible);
			unit_t* base = nullptr;
			for (unit_t* unit : ptr(st.player_units[6])) if (unit->unit_type->id == UnitTypes::Terran_Command_Center) base = unit;
			require(base != nullptr, "original base for refinery resources needed by flagship repair");
			functions.move_unit(worker, base->sprite->position + xy(48, 0));
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			unit_t* refinery = nullptr;
			for (unit_t* unit : ptr(st.player_units[0])) if (unit->unit_type->id == UnitTypes::Terran_Refinery) refinery = unit;
			if (!refinery) {
				unit_t* mineral = functions.find_nearest_unit(worker, functions.map_bounds(), [&](unit_t* unit) { return functions.unit_is_mineral_field(unit) && functions.is_reachable(worker, unit); });
				require(mineral != nullptr, "original base minerals for native Refinery construction");
				functions.set_unit_order(worker, functions.get_order_type(Orders::MoveToMinerals), mineral);
				for (int tick = 0; tick != 2000 && st.current_minerals[0] < 125; ++tick) functions.next_frame();
				require(st.current_minerals[0] >= 125, "original SCV gathers actual minerals before building a Refinery");
				unit_t* geyser = functions.find_nearest_unit(worker, functions.map_bounds(), [&](unit_t* unit) { return unit->unit_type->id == UnitTypes::Resource_Vespene_Geyser && functions.is_reachable(worker, unit); });
				require(geyser != nullptr, "original geyser for native Refinery placement");
				functions.place_building(worker, functions.get_order_type(Orders::PlaceBuilding), functions.get_unit_type(UnitTypes::Terran_Refinery), geyser->sprite->position);
				for (int tick = 0; tick != 2000 && !refinery; ++tick) {
					functions.next_frame();
					for (unit_t* unit : ptr(st.player_units[0])) if (unit->unit_type->id == UnitTypes::Terran_Refinery && functions.u_completed(unit)) refinery = unit;
				}
			}
			require(refinery != nullptr, "original worker completes native Refinery construction");
			functions.set_unit_order(worker, functions.get_order_type(Orders::MoveToGas), refinery);
			for (int tick = 0; tick != 1200 && !st.current_gas[0]; ++tick) functions.next_frame();
			require(st.current_gas[0] > 0, "original SCV mines actual refinery gas for native repair costs");
			functions.move_unit(worker, flagship->sprite->position + xy(48, 0));
			flagship->main_order_timer = 0;
			functions.order_RescuePassive(flagship);
			require(flagship->owner == 0, "native proximity rescues the original crashed flagship");
			functions.u_set_status_flag(flagship, unit_t::status_flag_invincible);
			functions.set_unit_hp(flagship, flagship->unit_type->hitpoints / 2);
			auto previous_hp = flagship->hp;
			functions.set_unit_order(worker, functions.get_order_type(Orders::Repair), flagship);
			for (int tick = 0; tick != 120; ++tick) functions.next_frame();
			if (flagship->hp <= previous_hp) printf("Norad repair diagnostic: hp=%d previous=%d worker_order=%d state=%d mechanical=%d completed=%d race=%d reachable=%d minerals=%d gas=%d\n", flagship->hp.integer_part(), previous_hp.integer_part(), int(worker->order_type->id), worker->order_state, functions.ut_mechanical(flagship), functions.u_completed(flagship), int(functions.unit_race(flagship)), functions.is_reachable(worker, flagship), st.current_minerals[0], st.current_gas[0]);
			require(flagship->hp > previous_hp && !st.players[0].victory_state, "original SCV repairs the rescued flagship without satisfying rescue victory alone");
			printf("Norad II original flagship rescue and repair passed.\n");
			continue;
		}
		if (scenario == 7) {
			unit_t* marine = nullptr;
			for (int owner : {0, 2}) for (unit_t* unit : ptr(st.player_units[owner])) {
				functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
				if (unit->owner == 0 && unit->unit_type->id == UnitTypes::Terran_Marine) marine = unit;
			}
			const auto& area = st.locations.at(1).area;
			unit_t* reinforcement = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Zerg_Hydralisk), (area.from + area.to) / 2 - xy(64, 0), 4);
			require(marine && reinforcement, "original crash-site burrowed reinforcement fixture");
			functions.apply_creation_properties(reinforcement, st.game->unit_properties.at(0));
			functions.u_set_status_flag(reinforcement, unit_t::status_flag_invincible);
			for (int tick = 0; tick != 120; ++tick) functions.next_frame();
			require(functions.u_burrowed(reinforcement), "original Norad II creation property reaches native Burrowed state");
			functions.u_unset_status_flag(marine, unit_t::status_flag_invincible);
			functions.move_unit(marine, reinforcement->sprite->position + xy(48, 0));
			functions.set_unit_order(marine, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 240 && functions.u_burrowed(reinforcement); ++tick) {
				functions.set_sprite_visibility(marine->sprite, 0xff);
				functions.next_frame();
			}
			require(!functions.u_burrowed(reinforcement), "authored burrowed reinforcement emerges for a nearby visible enemy");
			printf("Norad II authored burrowed reinforcement passed.\n");
			continue;
		}
		if (scenario >= 1 && scenario <= 3) {
			for (unit_t* unit : ptr(st.player_units[0])) functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
			functions.u_set_status_flag(flagship, unit_t::status_flag_invincible);
			const auto& destination = st.locations.at(1).area;
			xy center = (destination.from + destination.to) / 2;
			functions.move_unit(raynor, center - xy(48, 0));
			raynor->main_order_timer = 0;
			functions.order_RescuePassive(raynor);
			if (raynor->owner != 0) {
				unit_t* marine = nullptr;
				for (unit_t* unit : ptr(st.player_units[0])) if (unit->unit_type->id == UnitTypes::Terran_Marine) marine = unit;
				functions.move_unit(marine, raynor->sprite->position + xy(48, 0));
				functions.order_RescuePassive(raynor);
			}
			functions.set_unit_order(raynor, functions.get_order_type(Orders::HoldPosition));
			for (int count = 0; count < scenario - 1; ++count) {
				unit_t* transport = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Dropship), center + xy(0, count * 32), 0);
				require(transport != nullptr, "native Dropship for original rescue predicate fixture");
				functions.u_set_status_flag(transport, unit_t::status_flag_invincible);
			}
		}
		if (scenario == 4) functions.kill_unit(raynor);
		if (scenario == 5) functions.kill_unit(flagship);
		if (scenario == 6) {
			a_vector<unit_t*> units;
			for (unit_t* unit : ptr(st.player_units[0])) units.push_back(unit);
			for (unit_t* unit : units) functions.kill_unit(unit);
		}
		bool paused = false;
		for (int tick = 0; tick != 4000 && !st.players[0].victory_state; ++tick) {
			functions.next_frame();
			if (st.scripted_pause) paused = true;
		}
		if (scenario <= 2) require(!st.players[0].victory_state, "idle or fewer than two Dropships cannot satisfy the original Norad II rescue victory");
		if (scenario == 3) require(st.players[0].victory_state >= 3 && paused, "Raynor plus two Dropships completes the original paused rescue victory");
		if (scenario >= 4) require(st.players[0].victory_state == 2, "original Raynor, flagship or squad loss reaches defeat");
		printf("Norad II original mission case %d passed.\n", scenario);
	}
}

static void trump_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 8; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions game_load(player.st());
		game_load.setup_info.victory_condition = 0;
		game_load.setup_info.tournament_mode = 0;
		game_load.setup_info.starting_units = 0;
		game_load.setup_info.resource_type = 0;
		game_load.setup_info.starting_minerals = 0;
		game_load.setup_info.create_melee_units_for_player = {};
		game_load.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		for (int tick = 0; tick != 32; ++tick) player.next_frame();
		state_functions functions(st);
		unit_t* carrier = nullptr;
		unit_t* worker = nullptr;
		unit_t* kerrigan = nullptr;
		unit_t* vessel = nullptr;
		for (unit_t* unit : ptr(st.player_units[0])) {
			functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
			if (unit->unit_type->id == UnitTypes::Hero_Sarah_Kerrigan) kerrigan = unit;
			if (unit->unit_type->id == UnitTypes::Terran_Science_Vessel) vessel = unit;
			if (unit->unit_type->id == UnitTypes::Terran_SCV) {
				if (unit->worker.powerup) carrier = unit;
				else worker = unit;
			}
		}
		require(carrier && worker && kerrigan && vessel, "original emitter SCV, worker, Kerrigan and Science Vessel");
		require(functions.unit_is_at_elevation_flags(carrier, 56) && !functions.unit_is_at_elevation_flags(vessel, 56), "ground-only beacon admits workers and excludes flying units");
		require(st.current_minerals[0] == 170 && st.current_gas[0] == 0, "original Trump Card opening resources");
		unit_t* emitter = carrier->worker.powerup;
		require(functions.us_hidden(emitter) && carrier->carrying_flags == 4, "emitter is a native hidden carried item");
		require(functions.find_image(carrier->sprite, ImageTypes::IMAGEID_Psi_Emitter, ImageTypes::IMAGEID_Psi_Emitter), "native psi-emitter carry overlay");
		const auto& beacon = st.locations.at(0).area;
		xy destination = (beacon.from + beacon.to) / 2;
		if (scenario == 7) {
			unit_t* tower = nullptr;
			for (unit_t* unit : ptr(st.player_units[4])) if (unit->unit_type->id == UnitTypes::Terran_Control_Tower) tower = unit;
			require(tower && st.campaign_ai_scripts.size() == 1, "original Ter8 Control Tower and script for completion wait");
			auto& script = st.campaign_ai_scripts.front();
			require(st.global->ai_script.at(8704) == 9, "pinned original Ter8 wait_build instruction");
			auto request = st.campaign_ai[4].build_requests[UnitTypes::Terran_Control_Tower];
			script.position = 8704;
			script.wait = 0;
			functions.u_unset_status_flag(tower, unit_t::status_flag_completed);
			functions.progress_campaign_ai_scripts();
			require(script.position == 8704 && script.wait == 15, "wait_build remains blocked by unfinished construction");
			require(st.campaign_ai[4].build_requests[UnitTypes::Terran_Control_Tower] == request, "wait_build does not create a build request");
			functions.u_set_status_flag(tower, unit_t::status_flag_completed);
			script.wait = 0;
			functions.progress_campaign_ai_scripts();
			require(script.position != 8704, "native building completion releases wait_build");
			printf("The Trump Card AI completion wait passed.\n");
			continue;
		} else if (scenario == 6) {
			unit_t* transport = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Dropship), carrier->sprite->position + xy(64, 0), 0);
			require(transport != nullptr, "native transport for carried-emitter fixture");
			functions.u_set_status_flag(transport, unit_t::status_flag_invincible);
			functions.set_unit_order(carrier, functions.get_order_type(Orders::EnterTransport), transport);
			for (int tick = 0; tick != 400 && !functions.us_hidden(carrier); ++tick) functions.next_frame();
			require(functions.us_hidden(carrier) && carrier->worker.powerup == emitter, "native loading preserves the SCV's emitter");
			functions.move_unit(transport, destination);
			functions.set_unit_order(transport, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 96; ++tick) functions.next_frame();
			require(!st.players[0].victory_state && !st.scripted_pause, "flying over the ground-only beacon with cargo cannot win");
			functions.set_unit_order(transport, functions.get_order_type(Orders::MoveUnload), destination);
			for (int tick = 0; tick != 400 && functions.us_hidden(carrier); ++tick) functions.next_frame();
			require(!functions.us_hidden(carrier) && carrier->worker.powerup == emitter, "native unloading retains the original carried emitter");
		} else if (scenario == 1 || scenario == 2) {
			unit_t* target = scenario == 1 ? worker : carrier;
			functions.move_unit(target, destination);
			functions.set_unit_order(target, functions.get_order_type(Orders::HoldPosition));
		} else if (scenario == 3) functions.kill_unit(kerrigan);
		else if (scenario == 4) {
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[0])) if (!functions.ut_powerup(unit)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
		} else if (scenario == 5) {
			xy dropped = carrier->sprite->position;
			functions.kill_unit(carrier);
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(!functions.unit_dying(emitter) && !functions.us_hidden(emitter), "carrier death drops the surviving original emitter");
			require(emitter->sprite->position == dropped, "emitter drops at its carrier position");
			functions.move_unit(worker, dropped + xy(64, 0));
			functions.set_unit_order(worker, functions.get_order_type(Orders::HoldPosition));
			functions.order_PowerupIdle(emitter);
			require(!worker->worker.powerup, "worker outside native pickup area cannot collect the emitter");
			functions.move_unit(worker, dropped);
			functions.order_PowerupIdle(emitter);
			require(worker->worker.powerup == emitter && functions.us_hidden(emitter), "another original SCV recovers the dropped emitter");
			functions.move_unit(worker, destination);
		}
		for (int tick = 0; tick != 1400 && !st.players[0].victory_state; ++tick) functions.next_frame();
		if (scenario <= 1) require(!st.players[0].victory_state, "idle or an empty worker at the beacon cannot win");
		if (scenario == 2 || scenario == 5 || scenario == 6) require(st.players[0].victory_state >= 3, "carried original emitter satisfies the authored beacon victory");
		if (scenario == 3 || scenario == 4) require(st.players[0].victory_state == 2, "original Kerrigan or force loss reaches defeat");
		printf("The Trump Card original mission case %d passed.\n", scenario);
	}
}

static void big_push_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 6; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.victory_condition = 0;
		loader.setup_info.tournament_mode = 0;
		loader.setup_info.starting_units = 0;
		loader.setup_info.resource_type = 0;
		loader.setup_info.starting_minerals = 0;
		loader.setup_info.create_melee_units_for_player = {};
		loader.load_map(map_loader);
		state& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (int tick = 0; tick != 32; ++tick) functions.next_frame();
		unit_t* duke = nullptr;
		for (unit_t* unit : ptr(st.player_units[0])) {
			functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
			if (unit->unit_type->id == UnitTypes::Hero_Norad_II) duke = unit;
		}
		require(duke && duke->sprite->owner == 2, "original Duke is naturally rescued without changing his display color");
		if (scenario == 1) functions.kill_unit(duke);
		if (scenario == 2 || scenario == 3 || scenario == 4) {
			a_vector<unit_t*> victims;
			for (int owner : (scenario == 2 ? a_vector<int>{0} : scenario == 4 ? a_vector<int>{4} : a_vector<int>{4, 5})) {
				for (unit_t* unit : ptr(st.player_units[owner])) if (scenario == 2 || functions.ut_building(unit)) victims.push_back(unit);
			}
			for (unit_t* unit : victims) functions.kill_unit(unit);
		}
		if (scenario == 5) {
			a_vector<unit_t*> assigned;
			a_vector<std::pair<unit_t*, unit_t*>> claims;
			for (unit_t* addon : ptr(st.player_units[11])) {
				if (!functions.ut_addon(addon)) continue;
				unit_t* parent = nullptr;
				for (unit_t* unit : ptr(st.player_units[0])) {
					if (!functions.ut_flying_building(unit) || !functions.unit_can_attach_addon(unit, addon)) continue;
					if (std::find(assigned.begin(), assigned.end(), unit) == assigned.end()) { parent = unit; break; }
				}
				require(parent != nullptr, "original airborne parent for every abandoned add-on");
				assigned.push_back(parent);
				claims.emplace_back(parent, addon);
				functions.u_set_status_flag(addon, unit_t::status_flag_invincible);
				xy destination = addon->sprite->position - addon->unit_type->placement_size / 2 - addon->unit_type->addon_position + parent->unit_type->placement_size / 2;
				functions.set_unit_order(parent, functions.get_order_type(Orders::BuildingLand), destination);
			}
			require(claims.size() == 5, "original two silos, Control Tower, Covert Ops and Machine Shop");
			for (int tick = 0; tick != 3000; ++tick) functions.next_frame();
			for (const auto& claim : claims) {
				require(functions.u_grounded_building(claim.first) && !functions.u_flying(claim.first), "native landing grounds the original fleet building");
				require(claim.first->building.addon == claim.second && claim.second->owner == 0, "native landing claims its original abandoned add-on");
			}
			printf("The Big Push original fleet landing and abandoned add-ons passed.\n");
			unit_t* worker = nullptr;
			unit_t* transport = nullptr;
			unit_t* base = nullptr;
			for (unit_t* unit : ptr(st.player_units[0])) {
				if (unit->unit_type->id == UnitTypes::Terran_SCV) worker = unit;
				if (unit->unit_type->id == UnitTypes::Terran_Dropship) transport = unit;
				if (unit->unit_type->id == UnitTypes::Terran_Command_Center) base = unit;
			}
			require(worker && transport && base, "original SCV, Dropship and landed base for fleet relocation");
			functions.set_unit_order(worker, functions.get_order_type(Orders::EnterTransport), transport);
			for (int tick = 0; tick != 400 && !functions.us_hidden(worker); ++tick) functions.next_frame();
			require(functions.us_hidden(worker), "original SCV boards its original Dropship");
			functions.set_unit_order(transport, functions.get_order_type(Orders::MoveUnload), base->sprite->position + xy(-128, 64));
			for (int tick = 0; tick != 1600 && functions.us_hidden(worker); ++tick) functions.next_frame();
			require(!functions.us_hidden(worker) && functions.is_reachable(worker, base), "native transport unloads the SCV on the new base platform");
			unit_t* mineral = functions.find_nearest_unit(worker, functions.map_bounds(), [&](unit_t* unit) { return functions.unit_is_mineral_field(unit) && functions.is_reachable(worker, unit); });
			require(mineral != nullptr, "original minerals reachable from the new platform");
			int minerals_before = st.current_minerals[0];
			functions.set_unit_order(worker, functions.get_order_type(Orders::MoveToMinerals), mineral);
			for (int tick = 0; tick != 1800 && st.current_minerals[0] <= minerals_before; ++tick) functions.next_frame();
			require(st.current_minerals[0] > minerals_before, "original SCV mines and returns real minerals to the landed base");
			printf("The Big Push original transport relocation and economy passed.\n");
			std::array<bool, 2> fired{};
			bool light_air_fire = false;
			const int attack_budget = 9000 + 7500 + 3 * (500 + 180 * 15);
			for (int tick = 0; tick != attack_budget; ++tick) {
				for (unit_t* unit : ptr(st.player_units[0])) {
					functions.u_unset_status_flag(unit, unit_t::status_flag_invincible);
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
				}
				functions.next_frame();
				for (int index = 0; index != 2; ++index) for (unit_id id : st.campaign_ai[index + 4].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (unit->ground_weapon_cooldown || unit->air_weapon_cooldown) {
						fired[index] = true;
						if (index == 1 && functions.u_flying(unit)) light_air_fire = true;
					}
				}
				if (fired[0] && fired[1] && light_air_fire) break;
			}
			require(fired[0] && fired[1] && light_air_fire, "both original Confederate scripts deploy weapon-firing parties including the light air wave");
			printf("The Big Push original heavy/light town attacks and air combat passed.\n");
			continue;
		}
		for (int tick = 0; tick != 4000 && !st.players[0].victory_state; ++tick) functions.next_frame();
		if (scenario == 0 || scenario == 4) require(!st.players[0].victory_state, "idle fleet or one surviving Confederate force cannot satisfy the original victory");
		if (scenario == 0 || scenario == 4) require(st.trigger_switches[1] && st.trigger_switches[2] && st.campaign_ai[4].town_active && st.campaign_ai[5].town_active, "original elapsed-time or Deaths predicates activate both Confederate scripts");
		if (scenario == 1 || scenario == 2) require(st.players[0].victory_state == 2, "original Duke or human-force loss reaches defeat");
		if (scenario == 3) require(st.players[0].victory_state >= 3, "destroying both original Confederate building forces reaches victory");
		printf("The Big Push original mission case %d passed.\n", scenario);
	}
}

static void finish_gettysburg_opening(state& st, state_functions& functions) {
	int budget = 64;
	for (const auto& action : st.game->triggers.at(2).actions) {
		if (!action.type) break;
		if (action.type == 4 || action.type == 7) {
			int duration = action.type == 7 ? functions.trigger_transmission_duration(action) : action.time_n;
			budget += (std::max(42, duration) + 41) / 42 + 3;
		}
	}
	for (int tick = 0; tick != budget && (st.scripted_pause || !st.campaign_ai[1].town_active); ++tick) functions.next_frame();
	require(!st.scripted_pause && st.campaign_ai[1].town_active && st.campaign_ai[3].town_active, "original paused opening completes and starts the original town scripts");
}

static void gettysburg_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 6; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.victory_condition = 0;
		loader.setup_info.tournament_mode = 0;
		loader.setup_info.starting_units = 0;
		loader.setup_info.resource_type = 0;
		loader.setup_info.starting_minerals = 0;
		loader.setup_info.create_melee_units_for_player = {};
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (int tick = 0; tick != 32; ++tick) functions.next_frame();
		unit_t* kerrigan = nullptr;
		for (int owner : {0, 3}) for (unit_t* unit : ptr(st.player_units[owner])) {
			functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
			if (unit->unit_type->id == UnitTypes::Hero_Sarah_Kerrigan) kerrigan = unit;
		}
		require(kerrigan && kerrigan->owner == 0 && kerrigan->sprite->owner == 2, "original Kerrigan is naturally rescued with her original display color");
		finish_gettysburg_opening(st, functions);
		require(st.current_minerals[0] == 250 && st.current_gas[0] == 150, "original New Gettysburg resources");
		if (scenario == 0) {
			functions.u_set_status_flag(kerrigan, unit_t::status_flag_cloaked);
			require(functions.unit_target_acquisition_range(kerrigan) == 0, "cloaked Ghost-family Kerrigan does not automatically acquire targets while idle");
			functions.set_unit_order(kerrigan, functions.get_order_type(Orders::AttackMove), kerrigan->sprite->position + xy(96, 0));
			require(functions.unit_target_acquisition_range(kerrigan) == 0, "cloaked Kerrigan does not automatically acquire targets through Attack-move");
			functions.set_unit_order(kerrigan, functions.get_order_type(Orders::HoldPosition));
			require(functions.unit_target_acquisition_range(kerrigan) > 0, "cloaked Ghost Hold Position permits automatic target acquisition");
			functions.set_unit_order(kerrigan, kerrigan->unit_type->return_to_idle);
			std::array<unit_t*, 2> targets{};
			for (unit_t* unit : ptr(st.player_units[1])) {
				int index = unit->unit_type->id == UnitTypes::Protoss_Zealot ? 0 : unit->unit_type->id == UnitTypes::Protoss_Dragoon ? 1 : -1;
				if (index < 0) continue;
				require(functions.unit_target_is_enemy(kerrigan, unit) && functions.unit_can_attack_target(kerrigan, unit), "cloaking does not prevent Kerrigan from recognizing valid Protoss attack targets");
				targets[index] = unit;
			}
			require(targets[0] && targets[1], "original New Gettysburg includes both Zealot and Dragoon targets");
			functions.u_set_status_flag(kerrigan, unit_t::status_flag_cloaked, false);
			require(functions.unit_target_acquisition_range(kerrigan) > 0, "decloaked Kerrigan resumes automatic acquisition");
			functions.set_secondary_order(kerrigan, functions.get_order_type(Orders::Cloak));
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(functions.u_cloaked(kerrigan), "original Kerrigan enters native cloaking before the combat check");
			xy original_position = kerrigan->sprite->position;
			for (unit_t* target : targets) {
				xy target_position = target->sprite->position;
				functions.move_unit(target, original_position + xy(96, 0));
				functions.set_unit_order(target, functions.get_order_type(Orders::HoldPosition));
				for (const order_type_t* order : {functions.get_order_type(Orders::HoldPosition), functions.get_order_type(kerrigan->unit_type->attack_unit->id)}) {
					functions.set_unit_order(kerrigan, kerrigan->unit_type->return_to_idle);
					for (int tick = 0; tick != 64; ++tick) {
						target->defensive_matrix_hp = fp8::integer(64000);
						target->defensive_matrix_timer = 250;
						functions.next_frame();
					}
					require(!kerrigan->ground_weapon_cooldown && !kerrigan->order_target.unit, "cloaked idle Kerrigan does not automatically fire at the nearby enemy");
					functions.issue_order(kerrigan, false, order, {original_position, order->id == Orders::HoldPosition ? nullptr : target});
					bool fired = false;
					for (int tick = 0; tick != 96 && !fired; ++tick) {
						target->defensive_matrix_hp = fp8::integer(64000);
						target->defensive_matrix_timer = 250;
						functions.next_frame();
						fired = kerrigan->ground_weapon_cooldown && kerrigan->order_target.unit == target;
					}
					require(fired && functions.u_cloaked(kerrigan), "cloaked Kerrigan fires at an original Zealot or Dragoon through Hold Position and direct Attack");
				}
				functions.move_unit(target, target_position);
				functions.move_unit(kerrigan, original_position);
			}
			functions.set_secondary_order(kerrigan, functions.get_order_type(Orders::Decloak));
			functions.set_unit_order(kerrigan, kerrigan->unit_type->return_to_idle);
			printf("New Gettysburg Kerrigan cloaked idle/Attack-move suppression, Hold Position and direct Attack passed.\n");
		}
		if (scenario == 1) functions.kill_unit(kerrigan);
		if (scenario == 2) {
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[0])) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
		}
		if (scenario == 3) {
			unit_t* zerg_building = nullptr;
			for (unit_t* unit : ptr(st.player_units[3])) if (unit->unit_type->id == UnitTypes::Zerg_Hydralisk_Den) zerg_building = unit;
			require(zerg_building != nullptr, "original Zerg building for the authored survival constraint");
			functions.kill_unit(zerg_building);
		}
		if (scenario == 4 || scenario == 5) {
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[1])) if (functions.ut_building(unit) && (scenario == 4 || unit->sprite->position.y > 2000)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
		}
		int outcome_budget = 64;
		for (int index : {0, 3, 5}) for (const auto& action : st.game->triggers.at(index).actions) {
			if (!action.type) break;
			if (action.type == 4 || action.type == 7) {
				int duration = action.type == 7 ? functions.trigger_transmission_duration(action) : action.time_n;
				outcome_budget += (std::max(42, duration) + 41) / 42 + 3;
			}
		}
		bool ending_reinforcements = false;
		bool repeated_reinforcements = false;
		int first_ending_zerglings = -1;
		for (int tick = 0; tick != outcome_budget && !st.players[0].victory_state; ++tick) {
			functions.next_frame();
			if (st.trigger_switches[9]) {
				ending_reinforcements = true;
				if (first_ending_zerglings == -1) first_ending_zerglings = st.unit_counts[3][UnitTypes::Zerg_Zergling];
				else if (st.unit_counts[3][UnitTypes::Zerg_Zergling] >= first_ending_zerglings + 5) repeated_reinforcements = true;
			}
		}
		if (scenario == 0 || scenario == 5) require(!st.players[0].victory_state, "idle or partial Protoss destruction cannot satisfy original victory");
		if (scenario >= 1 && scenario <= 3) require(st.players[0].victory_state == 2, "original Kerrigan, force or Zerg-building loss reaches defeat");
		if (scenario == 4) {
			require(st.players[0].victory_state >= 3 && ending_reinforcements, "original Protoss-building victory retains its authored ending waves");
			require(repeated_reinforcements, "preserved original ending trigger repeats its five-Zergling reinforcements before victory completes");
		}
		printf("New Gettysburg original mission case %d passed.\n", scenario);
	}
}

static void hammer_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 5; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.victory_condition = 0;
		loader.setup_info.tournament_mode = 0;
		loader.setup_info.starting_units = 0;
		loader.setup_info.resource_type = 0;
		loader.setup_info.starting_minerals = 0;
		loader.setup_info.create_melee_units_for_player = {};
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (int tick = 0; tick != 32; ++tick) functions.next_frame();
		unit_t* raynor = nullptr;
		unit_t* cannon = nullptr;
		for (unit_t* unit : ptr(st.player_units[1])) {
			functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
			if (unit->unit_type->id == UnitTypes::Hero_Jim_Raynor_Vulture) raynor = unit;
		}
		for (unit_t* unit : ptr(st.player_units[6])) if (unit->unit_type->id == UnitTypes::Special_Ion_Cannon) cannon = unit;
		require(raynor && cannon && raynor->sprite->owner == 2, "original rescued Raynor and Ion Cannon actors");
		if (scenario == 1) functions.kill_unit(raynor);
		if (scenario == 2 || scenario == 3) {
			a_vector<unit_t*> victims;
			for (int owner : (scenario == 2 ? a_vector<int>{1} : a_vector<int>{0, 6})) for (unit_t* unit : ptr(st.player_units[owner])) {
				if (scenario == 2 || (functions.ut_building(unit) && unit != cannon)) victims.push_back(unit);
			}
			for (unit_t* unit : victims) functions.kill_unit(unit);
		}
		if (scenario == 4) functions.kill_unit(cannon);
		int outcome_budget = 64;
		for (int index : {2, 4}) for (const auto& action : st.game->triggers.at(index).actions) {
			if (!action.type) break;
			if (action.type == 4 || action.type == 7) {
				int duration = action.type == 7 ? functions.trigger_transmission_duration(action) : action.time_n;
				outcome_budget += (std::max(42, duration) + 41) / 42 + 3;
			}
		}
		for (int tick = 0; tick != outcome_budget && !st.players[1].victory_state; ++tick) functions.next_frame();
		if (scenario == 0 || scenario == 3) require(!st.players[1].victory_state, "idle or other enemy buildings destroyed cannot replace the Ion Cannon objective");
		if (scenario == 1 || scenario == 2) require(st.players[1].victory_state == 2, "original Raynor or human-force loss reaches defeat");
		if (scenario == 4) require(st.players[1].victory_state >= 3 && st.building_counts[0] > 0, "destroying the original Ion Cannon wins without requiring all enemy bases destroyed");
		printf("The Hammer Falls original mission case %d passed.\n", scenario);
	}
}

static void among_ruins_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 8; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.victory_condition = 0;
		loader.setup_info.tournament_mode = 0;
		loader.setup_info.starting_units = 0;
		loader.setup_info.resource_type = 0;
		loader.setup_info.starting_minerals = 0;
		loader.setup_info.create_melee_units_for_player = {};
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		int opening_budget = 64;
		for (const auto& action : st.game->triggers.at(1).actions) if (action.type == 4 || action.type == 7) {
			int duration = action.type == 7 ? functions.trigger_transmission_duration(action) : action.time_n;
			opening_budget += (std::max(42, duration) + 41) / 42 + 3;
		}
		for (int tick = 0; tick != opening_budget; ++tick) functions.next_frame();
		if (scenario == 7) {
			for (unit_t* worker : ptr(st.player_units[3])) if (functions.unit_is(worker, UnitTypes::Zerg_Drone)) {
				unit_t* mineral = functions.find_nearest_unit(worker, functions.map_bounds(), [&](unit_t* unit) { return functions.unit_is_mineral_field(unit) && functions.is_reachable(worker, unit); });
				require(mineral, "original Drone has reachable original minerals");
				functions.set_unit_order(worker, functions.get_order_type(Orders::MoveToMinerals), mineral);
			}
			for (int tick = 0; tick != 6000 && st.current_minerals[3] < 500; ++tick) functions.next_frame();
			require(st.current_minerals[3] >= 500 && st.total_minerals_gathered[3] >= 300, "original Drones gather actual minerals for Zerg construction");
			auto build_paid = [&](UnitTypes id) -> unit_t* {
				unit_t* worker = nullptr;
				for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Zerg_Drone) && !functions.unit_dying(unit)) { worker = unit; break; }
				require(worker, "paid Zerg construction consumes an existing Drone");
				const auto* type = functions.get_unit_type(id);
				const auto* order = functions.get_order_type(Orders::DroneStartBuild);
				require(functions.unit_build_order_valid(worker, order, type, 3), "original mission permits this Drone construction order");
				bool placed = false;
				xy selected_position{};
				int selected_distance = 0x7fffffff;
				for (int vertical = 1; vertical < 64; ++vertical) for (int horizontal = 1; horizontal < 64; ++horizontal) {
					xy position = xy(horizontal * 32, vertical * 32) + type->placement_size / 2;
					if (!functions.is_reachable(worker->sprite->position, position - xy(0, 7)) || !functions.can_place_building(worker, 3, type, position, false, false)) continue;
					int distance = functions.xy_length(position - worker->sprite->position);
					if (distance < selected_distance) { selected_position = position; selected_distance = distance; placed = true; }
				}
				require(placed, "original creep or geyser supports legal native placement");
				functions.place_building(worker, order, type, selected_position);
				for (int tick = 0; tick != 3000; ++tick) {
					functions.next_frame();
					for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, id) && functions.u_completed(unit)) return unit;
				}
				return nullptr;
			};
			require(build_paid(UnitTypes::Zerg_Spawning_Pool), "Drone completes a paid native Spawning Pool on original creep");
			unit_t* extractor = build_paid(UnitTypes::Zerg_Extractor);
			require(extractor, "Drone completes a paid native Extractor on an original geyser");
			require(functions.campaign_ai_produce(3, functions.get_unit_type(UnitTypes::Zerg_Drone)), "native Larva production pays for a replacement Drone");
			unit_t* worker = nullptr;
			for (int tick = 0; tick != 1200 && !worker; ++tick) {
				functions.next_frame();
				for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Zerg_Drone) && functions.u_completed(unit)) worker = unit;
			}
			require(worker, "replacement Drone hatches through native morphing");
			functions.set_unit_order(worker, functions.get_order_type(Orders::MoveToGas), extractor);
			for (int tick = 0; tick != 3600 && st.current_gas[3] < 75; ++tick) functions.next_frame();
			require(st.current_gas[3] >= 75, "Drone gathers actual Extractor gas for the Den and Hydralisk");
			require(build_paid(UnitTypes::Zerg_Hydralisk_Den), "Drone completes a paid native Hydralisk Den");
			require(functions.campaign_ai_produce(3, functions.get_unit_type(UnitTypes::Zerg_Hydralisk)), "native Larva production respects Hydralisk prerequisites and costs");
			for (int tick = 0; tick != 1200 && !st.completed_unit_counts[3][UnitTypes::Zerg_Hydralisk]; ++tick) functions.next_frame();
			require(st.completed_unit_counts[3][UnitTypes::Zerg_Hydralisk] > 0 && !st.players[3].victory_state, "a paid native Hydralisk hatches without substituting for enemy-building clearance");
			printf("Among the Ruins native mineral/gas economy, Drone construction and Hydralisk production passed.\n");
			continue;
		}
		auto create_building = [&](UnitTypes id) -> unit_t* {
			const auto* type = functions.get_unit_type(id);
			for (int vertical = 1; vertical < 64; ++vertical) for (int horizontal = 1; horizontal < 64; ++horizontal) {
				xy position = xy(horizontal * 32, vertical * 32) + type->placement_size / 2;
				if (functions.can_place_building(nullptr, 3, type, position, false, false)) return functions.trigger_create_unit(type, position, 3);
			}
			return nullptr;
		};
		if (scenario == 1 || scenario == 3 || scenario == 4) require(create_building(UnitTypes::Zerg_Spawning_Pool), "original objective fixture has a native Spawning Pool");
		if (scenario == 2 || scenario == 3 || scenario == 4) require(create_building(UnitTypes::Zerg_Hydralisk_Den), "original objective fixture has a native Hydralisk Den");
		if (scenario >= 1 && scenario <= 3) {
			a_vector<unit_t*> buildings;
			for (unit_t* unit : ptr(st.player_units[5])) if (functions.ut_building(unit)) buildings.push_back(unit);
			for (unit_t* unit : buildings) functions.kill_unit(unit);
		}
		if (scenario == 5) {
			a_vector<unit_t*> humans;
			for (unit_t* unit : ptr(st.player_units[3])) humans.push_back(unit);
			for (unit_t* unit : humans) functions.kill_unit(unit);
		}
		if (scenario == 6) {
			int activation = 180 * 16;
			while (st.current_frame < activation - 32) functions.next_frame();
			require(!st.campaign_ai[5].town_active, "Zer1 does not start before the authored 180-second condition");
			for (int tick = 0; tick != 128 && !st.campaign_ai[5].town_active; ++tick) functions.next_frame();
			require(st.campaign_ai[5].town_active, "original trigger starts the original Zer1 town program");
			for (int tick = 0; tick != 32; ++tick) functions.next_frame();
			require(st.campaign_ai[5].build_requests[UnitTypes::Terran_Command_Center].first == 1 && st.campaign_ai[5].maximum_force == 500, "original enemy construction and force settings are interpreted without replacement AI");
			bool combat = false;
			for (int tick = 0; tick != 11000 && !combat; ++tick) {
				for (unit_t* unit : ptr(st.player_units[3])) { unit->hp = unit->unit_type->hitpoints; unit->defensive_matrix_hp = fp8::integer(1000); unit->defensive_matrix_timer = 100; }
				functions.next_frame();
				for (unit_t* unit : ptr(st.player_units[5])) {
					const unit_t* gun = functions.unit_attacking_unit(unit);
					if (gun->order_target.unit && gun->order_target.unit->owner == 3 && (gun->ground_weapon_cooldown || gun->air_weapon_cooldown)) combat = true;
				}
			}
			require(combat && !st.players[3].victory_state, "original Zer1 forces reach native weapon combat without inventing victory or waves");
			printf("Among the Ruins authored AI activation and native combat passed.\n");
			continue;
		}
		for (int tick = 0; tick != 160 && !st.players[3].victory_state; ++tick) functions.next_frame();
		if (scenario == 3) require(st.players[3].victory_state >= 3, "original victory requires enemy buildings cleared plus both Zerg tech structures");
		else if (scenario == 5) require(st.players[3].victory_state == 2, "original whole-human-force loss reaches defeat");
		else require(!st.players[3].victory_state, "each missing original objective prevents victory");
		printf("Among the Ruins original mission case %d passed.\n", scenario);
	}
}

static void egression_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 5; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.victory_condition = 0;
		loader.setup_info.tournament_mode = 0;
		loader.setup_info.starting_units = 0;
		loader.setup_info.resource_type = 0;
		loader.setup_info.starting_minerals = 0;
		loader.setup_info.create_melee_units_for_player = {};
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		int original_chrysalises = 0;
		for (int owner : all_player_slots) original_chrysalises += st.unit_counts[owner][UnitTypes::Powerup_Young_Chrysalis];
		require(original_chrysalises == 1 && st.unit_counts[11][UnitTypes::Powerup_Young_Chrysalis] == 1, "Egression retains its single original neutral Chrysalis without a synthetic duplicate");
		for (int tick = 0; tick != 64; ++tick) functions.next_frame();
		unit_t* standing = nullptr;
		unit_t* carrier = nullptr;
		unit_t* replacement = nullptr;
		for (unit_t* unit : ptr(st.player_units[3])) {
			functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
			if (functions.unit_is(unit, UnitTypes::Special_Zerg_Beacon)) standing = unit;
			if (functions.unit_is(unit, UnitTypes::Zerg_Drone)) {
				if (!carrier) carrier = unit;
				else replacement = unit;
			}
		}
		require(standing && carrier && replacement, "original standing Chrysalis and two Drones for Egression objective cases");
		const auto& destination_area = st.locations.at(0).area;
		xy destination = (destination_area.from + destination_area.to) / 2;
		if (scenario == 4) {
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[3])) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
		} else if (scenario == 0) {
			functions.move_unit(carrier, destination);
			functions.set_unit_order(carrier, functions.get_order_type(Orders::HoldPosition));
		} else {
			functions.set_unit_order(carrier, functions.get_order_type(Orders::Move), standing->sprite->position);
			for (int tick = 0; tick != 600 && !carrier->worker.powerup; ++tick) functions.next_frame();
			require(carrier->worker.powerup && functions.unit_is(carrier->worker.powerup, UnitTypes::Powerup_Young_Chrysalis), "ordinary Drone movement picks up the original tracked Chrysalis");
			unit_t* portable = carrier->worker.powerup;
			require(functions.us_hidden(portable) && carrier->carrying_flags == 4, "native hidden carried Chrysalis retains normal worker carrying state");
			ImageTypes overlay = ImageTypes(int(ImageTypes::IMAGEID_Flag) + int(UnitTypes::Powerup_Young_Chrysalis) - int(UnitTypes::Powerup_Flag));
			require(functions.find_image(carrier->sprite, overlay, overlay), "native Chrysalis carry overlay is present");
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.unit_counts[3][UnitTypes::Hero_Hunter_Killer] == 6, "original contact rescue gives the six Hunter Killers without synthetic reinforcements");
			if (scenario == 2 || scenario == 3) {
				xy dropped(768, 1088);
				functions.move_unit(carrier, dropped);
				functions.set_unit_order(carrier, functions.get_order_type(Orders::HoldPosition));
				functions.kill_unit(carrier);
				for (int tick = 0; tick != 600 && !st.countdown_timer; ++tick) functions.next_frame();
				require(!functions.unit_dying(portable) && !functions.us_hidden(portable) && portable->sprite->position == dropped, "carrier death drops the surviving Chrysalis at the actual carrier position");
				require(st.countdown_timer > 0 && !st.players[3].victory_state, "the original warning starts its recovery countdown without immediate defeat");
				if (scenario == 3) {
					functions.move_unit(replacement, dropped + xy(0, 40));
					functions.set_unit_order(replacement, functions.get_order_type(Orders::Move), dropped);
					for (int tick = 0; tick != 400 && replacement->worker.powerup != portable; ++tick) functions.next_frame();
					require(replacement->worker.powerup == portable, "the other original Drone recovers the same dropped Chrysalis");
					for (int tick = 0; tick != 640 && st.countdown_timer; ++tick) functions.next_frame();
					require(st.countdown_timer == 0 && !st.players[3].victory_state, "the original recovery trigger clears the countdown before defeat");
					carrier = replacement;
				}
			}
			if (scenario == 1 || scenario == 3) {
				functions.move_unit(carrier, destination);
				functions.set_unit_order(carrier, functions.get_order_type(Orders::HoldPosition));
			}
		}
		bool paused = false;
		for (int tick = 0; tick != 4000 && !st.players[3].victory_state; ++tick) {
			functions.next_frame();
			if (st.scripted_pause) paused = true;
		}
		if (scenario == 0) require(!st.players[3].victory_state, "an empty Drone at the destination beacon cannot win Egression");
		if (scenario == 1 || scenario == 3) require(st.players[3].victory_state >= 3 && paused, "the original carried-Chrysalis delivery reaches its paused dialogue and victory");
		if (scenario == 2 || scenario == 4) require(st.players[3].victory_state == 2, "original recovery expiry or whole-human-force loss reaches defeat");
		printf("Egression original mission case %d passed.\n", scenario);
	}
}

static void new_dominion_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 3; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (int tick = 0; tick != 64; ++tick) functions.next_frame();
		for (unit_t* unit : ptr(st.player_units[3])) functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
		a_vector<unit_t*> victims;
		if (scenario == 1) for (unit_t* unit : ptr(st.player_units[6])) if (functions.ut_building(unit)) victims.push_back(unit);
		if (scenario == 2) for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Special_Mature_Chrysalis)) victims.push_back(unit);
		if (scenario) require(!victims.empty(), "original mission outcome fixture has its authored objective actors");
		for (unit_t* unit : victims) functions.kill_unit(unit);
		bool paused = false;
		for (int tick = 0; tick != 3000 && !st.players[3].victory_state; ++tick) { functions.next_frame(); paused = paused || st.scripted_pause; }
		if (scenario == 0) require(!st.players[3].victory_state, "idle original New Dominion cannot invent a victory or defeat");
		if (scenario == 1) require(st.players[3].victory_state >= 3 && paused, "original Terran building elimination reaches New Dominion ending dialogue and victory");
		if (scenario == 2) require(st.players[3].victory_state == 2 && paused, "original Chrysalis loss reaches New Dominion defeat");
		printf("The New Dominion original mission case %d passed.\n", scenario);
	}
}

static void agent_swarm_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 5; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		bool original_attack_fired = false;
		auto step = [&]() {
			for (unit_t* unit : ptr(st.player_units[3])) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				if (functions.ut_building(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
			if (scenario == 4) for (unit_id id : st.campaign_ai[1].attacking) {
				unit_t* unit = functions.get_unit(id);
				if (unit && !functions.unit_dying(unit) && !functions.us_hidden(unit) && unit->ground_weapon_cooldown) original_attack_fired = true;
			}
		};
		for (int tick = 0; tick != 64; ++tick) step();
		unit_t* chrysalis = nullptr;
		for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Special_Mature_Chrysalis)) chrysalis = unit;
		require(chrysalis && st.unit_counts[3][UnitTypes::Hero_Infested_Kerrigan] == 0, "original Agent of the Swarm begins with the Chrysalis, not a granted Kerrigan");
		if (scenario == 0) functions.kill_unit(chrysalis);
		unit_t* kerrigan = nullptr;
		for (int tick = 0; tick != 12500 && !st.players[3].victory_state && !kerrigan; ++tick) {
			step();
			for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Hero_Infested_Kerrigan) && !functions.unit_dying(unit)) kerrigan = unit;
		}
		if (scenario == 0) {
			require(st.players[3].victory_state == 2 && !kerrigan, "original pre-hatch Chrysalis loss reaches defeat");
			printf("Agent of the Swarm original Chrysalis defeat passed.\n");
			continue;
		}
		require(kerrigan && st.current_frame >= 600 * 16 && st.unit_counts[3][UnitTypes::Special_Mature_Chrysalis] == 0, "the original countdown expires naturally before its trigger replaces the Chrysalis with Kerrigan");
		require(functions.unit_can_use_tech(kerrigan, functions.get_tech_type(TechTypes::Personnel_Cloaking)) && !functions.unit_can_use_tech(kerrigan, functions.get_tech_type(TechTypes::Psionic_Storm)), "original hatched Kerrigan can cloak but cannot bypass mission-disabled Psionic Storm");
		for (int tick = 0; tick != 1800; ++tick) step();
		require(!st.scripted_pause && !st.players[3].victory_state, "the original hatch dialogue and scene cleanup complete without an invented outcome");
		unit_t* command_center = nullptr;
		for (unit_t* unit : ptr(st.player_units[2])) if (functions.unit_is(unit, UnitTypes::Terran_Command_Center)) command_center = unit;
		require(command_center, "original Raynor Command Center remains the post-hatch objective");
		if (scenario == 1) functions.kill_unit(command_center);
		if (scenario == 2) {
			unit_t* queen = nullptr;
			for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Zerg_Queen)) queen = unit;
			require(queen, "original Queen is available for the authored infestation victory route");
			functions.set_unit_hp(command_center, command_center->unit_type->hitpoints / 4);
			functions.move_unit(queen, command_center->sprite->position + xy(64, 0));
			functions.set_unit_order(queen, functions.get_order_type(Orders::CastInfestation), command_center);
		}
		if (scenario == 3) functions.kill_unit(kerrigan);
		bool paused = false;
		for (int tick = 0; tick != 3000 && !st.players[3].victory_state; ++tick) { step(); paused = paused || st.scripted_pause; }
		if (scenario == 1 || scenario == 2) require(st.players[3].victory_state >= 3 && paused, "destroying or natively infesting Raynor's Command Center reaches the original ending and victory");
		if (scenario == 2) require(st.unit_counts[3][UnitTypes::Zerg_Infested_Command_Center] == 1, "native Queen infestation transfers the original Command Center to the human Zerg");
		if (scenario == 3) require(st.players[3].victory_state == 2, "original post-hatch Kerrigan loss reaches defeat");
		if (scenario == 4) {
			require(!st.players[3].victory_state, "post-hatch idle state cannot bypass the Raynor objective");
			require(original_attack_fired, "original Zer4 attack schedule reaches human actors and fires native weapons without extra resources or replacement waves");
		}
		printf("Agent of the Swarm original mission case %d passed.\n", scenario);
	}
}

static void amerigo_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 4; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		auto step = [&]() {
			for (unit_t* unit : ptr(st.player_units[3])) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 600; ++tick) step();
		unit_t* kerrigan = nullptr;
		unit_t* zergling = nullptr;
		for (unit_t* unit : ptr(st.player_units[3])) {
			if (functions.unit_is(unit, UnitTypes::Hero_Infested_Kerrigan)) kerrigan = unit;
			if (functions.unit_is(unit, UnitTypes::Zerg_Zergling)) zergling = unit;
		}
		require(kerrigan && zergling && st.campaign_ai_scripts.empty() && !st.scripted_pause && !st.players[3].victory_state, "The Amerigo preserves its original squad and completes the opening without an invented town AI or outcome");
		require(functions.unit_can_use_tech(kerrigan, functions.get_tech_type(TechTypes::Personnel_Cloaking)) && !functions.unit_can_use_tech(kerrigan, functions.get_tech_type(TechTypes::Psionic_Storm)), "original Amerigo Kerrigan retains hero cloak eligibility and mission-disabled Psionic Storm");
		auto position_at = [&](int location) { const auto& area = st.locations.at(location - 1).area; return (area.from + area.to) / 2; };
		if (scenario == 0) {
			unit_t* civilian = nullptr;
			for (unit_t* unit : ptr(st.player_units[6])) if (unit->unit_type->id == (UnitTypes)15) civilian = unit;
			require(civilian, "original computer Civilian provides the location-condition fixture");
			st.locations.push_back(st.locations.at(17));
			st.locations.back().area = functions.square_at(civilian->sprite->position, 1);
			trigger::condition condition{};
			condition.location = int(st.locations.size()); condition.unit_id = 15; condition.type = 7;
			require(functions.test_trigger_condition(condition, 6) && !functions.test_trigger_condition(condition, 3), "Command Most At Location uses the executing player, not the unused group field");
			condition.type = 17;
			require(!functions.test_trigger_condition(condition, 6) && functions.test_trigger_condition(condition, 3), "Command Least At Location compares the executing player's actual local count");
			st.locations.back().area = rect(xy(0, 0), xy(1, 1));
			require(functions.test_trigger_condition(condition, 6), "Command Least At Location permits a zero-count tie");
			condition.type = 7;
			require(functions.test_trigger_condition(condition, 6), "Command Most At Location permits a zero-count tie");
			unit_t* door = nullptr;
			for (unit_t* unit : functions.find_units(st.locations.at(21).area)) if (unit->unit_type->id == (UnitTypes)208) door = unit;
			require(door && !functions.u_no_collide(door), "the original prison door begins closed");
			functions.move_unit(zergling, position_at(24));
			functions.set_unit_order(zergling, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 600; ++tick) step();
			require(functions.u_no_collide(door) && functions.u_disabled(door), "the original prison control trigger opens the native door and removes collision");
			require(st.unit_counts[3][(UnitTypes)53] == 2 && st.unit_counts[0][(UnitTypes)53] == 0, "native proximity naturally rescues the two original Hunter Killers during the opening");
			functions.move_unit(zergling, position_at(3) - xy(0, 80));
			functions.issue_order(zergling, false, functions.get_order_type(Orders::Move), {position_at(3), nullptr});
			bool teleported = false;
			for (int tick = 0; tick != 800; ++tick) { step(); if (functions.xy_length(zergling->sprite->position - position_at(6)) < 192) teleported = true; }
			require(teleported, "native movement onto the original beacon activates the repeatable sector-five-to-six teleporter");
			require(!st.players[3].victory_state, "door controls, reinforcements and teleporting do not invent victory");
		} else {
			if (scenario == 1) functions.move_unit(kerrigan, position_at(20));
			if (scenario == 2) functions.kill_unit(kerrigan);
			if (scenario == 3) functions.move_unit(zergling, position_at(20));
			bool paused = false;
			for (int tick = 0; tick != 1800 && !st.players[3].victory_state; ++tick) { step(); paused = paused || st.scripted_pause; }
			if (scenario == 1) require(st.players[3].victory_state >= 3 && paused, "Kerrigan reaches the original Supercomputer download sequence and victory");
			if (scenario == 2) require(st.players[3].victory_state == 2, "original Kerrigan loss reaches defeat");
			if (scenario == 3) require(!st.players[3].victory_state, "a non-Kerrigan actor cannot satisfy the original Supercomputer objective");
		}
		printf("The Amerigo original mission case %d passed.\n", scenario);
	}
}

static void dark_templar_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 6; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		auto tassadar_actor = [&]() -> unit_t* {
			for (unit_t* unit : ptr(st.player_units[2])) if (functions.unit_is(unit, UnitTypes::Hero_Tassadar) && !functions.unit_dying(unit)) return unit;
			return nullptr;
		};
		auto step = [&]() {
			for (unit_t* unit : ptr(st.player_units[3])) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				if (functions.ut_building(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 1200; ++tick) step();
		unit_t* kerrigan = nullptr;
		unit_t* companion = nullptr;
		for (unit_t* unit : ptr(st.player_units[3])) {
			if (functions.unit_is(unit, UnitTypes::Hero_Infested_Kerrigan)) kerrigan = unit;
			if (functions.unit_is(unit, UnitTypes::Zerg_Hydralisk)) companion = unit;
		}
		require(kerrigan && companion && !st.trigger_switches[0] && !st.players[3].victory_state, "The Dark Templar starts before its original camp-clear/challenge gate");
		require(functions.unit_can_use_tech(kerrigan, functions.get_tech_type(TechTypes::Personnel_Cloaking)) && functions.unit_can_use_tech(kerrigan, functions.get_tech_type(TechTypes::Psionic_Storm)) && !st.tech_researched[3][TechTypes::Psionic_Storm], "original mission permits Kerrigan's native hero cloak and Storm without granting ordinary-unit research");
		auto center = [&](int location) { const auto& area = st.locations.at(location - 1).area; return (area.from + area.to) / 2; };
		auto clear_camp = [&](int location) {
			a_vector<unit_t*> victims;
			for (unit_t* unit : functions.find_units(st.locations.at(location - 1).area)) if (unit->owner == 1 && !functions.ut_turret(unit)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
		};
		if (scenario == 0) functions.kill_unit(kerrigan);
		if (scenario == 1) {
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[3])) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
		}
		if (scenario == 2) clear_camp(4);
		if (scenario >= 3) { clear_camp(4); clear_camp(5); }
		for (int tick = 0; tick != 2200 && !st.players[3].victory_state; ++tick) step();
		if (scenario <= 1) require(st.players[3].victory_state == 2, "original Kerrigan loss or whole-force loss reaches defeat");
		if (scenario == 2) require(!st.trigger_switches[0] && !tassadar_actor() && !st.players[3].victory_state, "clearing only one original Protoss camp cannot start the challenge or win");
		if (scenario >= 3) {
			require(st.trigger_switches[0] && !st.scripted_pause && !st.players[3].victory_state && !tassadar_actor(), "clearing both original regions completes the challenge dialogue but is not victory");
			if (scenario == 3) {
				xy previous = companion->sprite->position;
				functions.move_unit(companion, center(6) + xy(48, 0));
				functions.set_unit_order(companion, functions.get_order_type(Orders::HoldPosition));
				functions.move_unit(kerrigan, center(6));
				functions.set_unit_order(kerrigan, functions.get_order_type(Orders::HoldPosition));
				for (int tick = 0; tick != 320; ++tick) step();
				require(!tassadar_actor() && !st.trigger_switches[1], "an accompanying original Hydralisk prevents Kerrigan from satisfying the alone predicate");
				functions.move_unit(companion, previous);
				unit_t* tassadar = nullptr;
				for (int tick = 0; tick != 320 && !tassadar; ++tick) {
					step();
					tassadar = tassadar_actor();
				}
				require(tassadar && functions.u_hallucination(tassadar) && st.trigger_switches[1], "Kerrigan alone creates exactly the original hallucinated Tassadar through source UPRP properties");
				unit_id tassadar_id = functions.get_unit_id(tassadar);
				fp8 initial_life = tassadar->hp + tassadar->shield_points;
				functions.issue_order(kerrigan, false, kerrigan->unit_type->attack_unit, {tassadar->sprite->position, tassadar});
				bool damaged = false;
				for (int tick = 0; tick != 600 && tassadar_actor(); ++tick) {
					step();
					unit_t* current = functions.get_unit(tassadar_id);
					if (current && current->hp + current->shield_points < initial_life) damaged = true;
				}
				require(damaged && !tassadar_actor(), "native Kerrigan weapons can damage the authored illusion before the original ending removes it");
				bool paused = false;
				for (int tick = 0; tick != 2200 && !st.players[3].victory_state; ++tick) { step(); paused = paused || st.scripted_pause; }
				require(st.players[3].victory_state >= 3 && paused, "the original illusion ending, dialogue and paused victory complete without a replacement objective");
			}
			if (scenario == 4) {
				functions.move_unit(companion, center(6));
				functions.set_unit_order(companion, functions.get_order_type(Orders::HoldPosition));
				for (int tick = 0; tick != 600; ++tick) step();
				require(!tassadar_actor() && !st.players[3].victory_state, "a non-Kerrigan visitor cannot trigger Tassadar or victory");
			}
			if (scenario == 5) {
				require(!st.players[3].victory_state && !tassadar_actor(), "waiting after camp destruction cannot bypass the original challenge");
				functions.move_unit(kerrigan, center(6));
				functions.set_unit_order(kerrigan, functions.get_order_type(Orders::Nothing));
				bool observed_illusion = false;
				for (int tick = 0; tick != 2200 && !st.players[3].victory_state; ++tick) { step(); if (tassadar_actor()) observed_illusion = true; }
				require(observed_illusion && st.players[3].victory_state >= 3, "Kerrigan arriving alone completes the original illusion ending without an invented kill objective");
			}
		}
		printf("The Dark Templar original mission case %d passed.\n", scenario);
	}
}

static void culling_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 6; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[3])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (unit_t* unit : ptr(st.player_units[3])) { unit->defensive_matrix_hp = fp8::integer(64000); unit->defensive_matrix_timer = 250; }
			if (scenario == 3 || scenario == 4) for (unit_t* unit : ptr(st.player_units[4])) if (functions.ut_building(unit) && !functions.unit_dying(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		require(!st.trigger_switches[10] && st.campaign_ai_scripts.empty() && !st.players[3].victory_state, "The Culling starts before its original Garm activation gate");
		if (scenario <= 2) {
			unit_t* last_building = nullptr;
			if (scenario == 2) for (unit_t* unit : ptr(st.player_units[4])) if (functions.unit_is(unit, UnitTypes::Zerg_Extractor)) last_building = unit;
			if (scenario == 2) require(last_building, "original Extractor supplies the remaining-building negative case");
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[scenario == 0 ? 3 : 4])) if (scenario == 0 || (functions.ut_building(unit) && unit != last_building)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
			for (int tick = 0; tick != 700 && !st.players[3].victory_state; ++tick) step();
			if (scenario == 0) require(st.players[3].victory_state == 2, "the original whole-human-force loss reaches defeat");
			if (scenario == 1) {
				require(st.players[3].victory_state >= 3 && st.non_building_counts[4] > 0, "the authored Garm-building predicate reaches victory even while enemy mobile units remain");
				auto pending_creep = [&]() {
					int count = 0;
					for (unit_t* unit : ptr(st.dead_units)) if (functions.u_status_flag(unit, unit_t::status_flag_4000)) ++count;
					return count;
				};
				require(pending_creep() > 0, "original mass Garm destruction exercises the bounded creep queue retry path");
				for (int tick = 0; tick != 12000 && pending_creep(); ++tick) step();
				require(!pending_creep(), "pending dead creep providers finish their existing recession scheduling instead of leaking indefinitely");
			}
			if (scenario == 2) require(!st.players[3].victory_state && st.building_counts[4] > 0, "a surviving Garm building prevents the authored victory");
		} else if (scenario <= 4) {
			unit_t* overlord = nullptr;
			for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Zerg_Overlord)) overlord = unit;
			require(overlord, "original Overlord supplies normal contact-trigger movement");
			const auto& area = st.locations.at(scenario == 3 ? 2 : 4).area;
			xy destination = (area.from + area.to) / 2;
			functions.move_unit(overlord, xy(destination.x, area.from.y - 64));
			functions.issue_order(overlord, false, functions.get_order_type(Orders::Move), {destination, nullptr});
			for (int tick = 0; tick != 800; ++tick) step();
			require(st.trigger_switches[10] && st.campaign_ai_scripts.size() == 4 && st.campaign_ai[4].area_towns.size() == 3 && st.current_frame < 300 * 16, "normal Overlord contact with either original satellite region starts the four Garm programs before the timer");
		} else {
			a_vector<unit_t*> victims;
			for (unit_t* unit : functions.find_units(st.locations.at(3).area)) if (unit->owner == 4 && functions.ut_building(unit)) victims.push_back(unit);
			require(!victims.empty(), "original south camp contains the activation-trigger buildings");
			for (unit_t* unit : victims) functions.kill_unit(unit);
			for (int tick = 0; tick != 8; ++tick) step();
			require(!st.trigger_switches[10] && st.campaign_ai_scripts.empty(), "clearing the south camp does not skip the source ten-second wait");
			for (int tick = 0; tick != 480; ++tick) step();
			require(st.trigger_switches[10] && st.campaign_ai_scripts.size() == 4 && st.campaign_ai[4].area_towns.size() == 3 && !st.players[3].victory_state, "the original south-camp delay activates Garm AI without inventing victory");
		}
		printf("The Culling original mission case %d passed.\n", scenario);
	}
}

static void eye_for_eye_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 11; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[3])) if (!functions.ut_building(unit)) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (unit_t* unit : ptr(st.player_units[3])) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				if (functions.ut_building(unit) && !functions.unit_dying(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 128; ++tick) step();
		unit_t* kerrigan = nullptr;
		unit_t* hydralisk = nullptr;
		for (unit_t* unit : ptr(st.player_units[3])) {
			if (functions.unit_is(unit, UnitTypes::Hero_Infested_Kerrigan)) kerrigan = unit;
			if (functions.unit_is(unit, UnitTypes::Zerg_Hydralisk)) hydralisk = unit;
		}
		require(kerrigan && hydralisk && !st.players[3].victory_state, "Eye for an Eye preserves original actors and no opening outcome");
		auto center = [&](int location) { const auto& area = st.locations.at(location - 1).area; return (area.from + area.to) / 2; };
		if (scenario <= 3) {
			if (scenario == 0) functions.kill_unit(kerrigan);
			if (scenario == 1) {
				a_vector<unit_t*> victims;
				for (unit_t* unit : ptr(st.player_units[3])) victims.push_back(unit);
				for (unit_t* unit : victims) functions.kill_unit(unit);
			}
			if (scenario >= 2) for (int owner : {1, 2}) {
				if (scenario == 2 && owner == 2) continue;
				a_vector<unit_t*> victims;
				for (unit_t* unit : ptr(st.player_units[owner])) if (functions.unit_is(unit, UnitTypes::Protoss_Nexus)) victims.push_back(unit);
				for (unit_t* unit : victims) functions.kill_unit(unit);
			}
			bool paused = false;
			for (int tick = 0; tick != (scenario == 2 ? 800 : 1800) && !st.players[3].victory_state; ++tick) { step(); paused = paused || st.scripted_pause; }
			if (scenario <= 1) require(st.players[3].victory_state == 2, "original Kerrigan loss or whole-human-force loss reaches defeat");
			if (scenario == 2) require(!st.players[3].victory_state && st.unit_counts[2][UnitTypes::Protoss_Nexus] > 0, "a surviving original Nexus prevents the ending");
			if (scenario == 3) require(st.players[3].victory_state >= 3 && paused && st.unit_counts[1][UnitTypes::Hero_Dark_Templar] >= 6 && st.building_counts[1] + st.building_counts[2] > 0, "destroying both Nexuses runs the original final Dark Templar creation/dialogue and victory without requiring all other buildings to die");
		} else if (scenario <= 6) {
			int route = scenario - 4;
			st.trigger_switches[10 + route] = true;
			unit_t* templar = nullptr;
			for (int tick = 0; tick != 128; ++tick) {
				step();
				for (unit_t* unit : ptr(st.player_units[1])) if (functions.unit_is(unit, UnitTypes::Hero_Dark_Templar) && !functions.unit_dying(unit)) templar = unit;
				if (templar && functions.u_cloaked(templar) && templar->order_type->id == Orders::Move) break;
			}
			require(templar && functions.u_cloaked(templar) && templar->order_type->id == Orders::Move, "the source creates the classic cloaked Dark Templar and MvTe assigns native Move");
			int destination = route == 0 ? 9 : route == 1 ? 7 : 6;
			require(templar->order_target.pos == center(destination), "move_dt uses the exact original script destination");
			xy spawn = templar->sprite->position;
			for (int tick = 0; tick != 32; ++tick) step();
			require(templar->sprite->position != spawn, "native path movement advances the source escape actor");
			functions.move_unit(templar, center(destination));
			functions.set_unit_order(templar, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 800 && !st.players[3].victory_state; ++tick) step();
			require(st.players[3].victory_state == 2, "each original Dark Templar exit independently reaches source defeat");
		} else if (scenario == 7) {
			std::array<unit_t*, 4> canals{};
			int index = 0;
			for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is_nydus(unit)) canals[index++] = unit;
			require(index == 4, "original canal transport fixture uses the four source units");
			for (unit_t* canal : canals) {
				unit_t* exit = canal->building.nydus.exit;
				require(exit && exit->building.nydus.exit == canal && functions.unit_can_enter_nydus(hydralisk, canal), "source reciprocal canal accepts an original human Hydralisk");
				auto approach = functions.find_unit_placement(hydralisk, canal->sprite->position + xy(64, 0), false);
				require(approach.first, "native placement provides a legal canal approach in the isolated transport fixture");
				functions.move_unit(hydralisk, approach.second);
				functions.issue_order(hydralisk, false, functions.get_order_type(Orders::EnterNydusCanal), {canal->sprite->position, canal});
				bool arrived = false;
				for (int tick = 0; tick != 400 && !arrived; ++tick) { step(); arrived = functions.xy_length(hydralisk->sprite->position - exit->sprite->position) < 160; }
				require(arrived && !functions.us_hidden(hydralisk), "native canal transport reaches the original linked exit and returns the actor to visible play");
			}
		} else if (scenario == 8) {
			unit_t* detector = nullptr;
			for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Zerg_Overlord) && functions.is_in_bounds(unit->sprite->position, st.locations.at(0).area)) detector = unit;
			require(detector && st.trigger_switches[0], "original Overlords begin covering the three authored detector regions");
			xy original = detector->sprite->position;
			functions.move_unit(detector, original + xy(640, 0));
			for (int tick = 0; tick != 400; ++tick) step();
			require(!st.trigger_switches[0] && !st.scripted_pause, "moving an original detector away runs and completes the source reposition reminder");
			functions.move_unit(detector, original);
			for (int tick = 0; tick != 400; ++tick) step();
			require(st.trigger_switches[0] && st.trigger_switches[13] && !st.players[3].victory_state, "restoring all original detector positions runs the source confirmation without inventing victory");
		} else if (scenario == 9) {
			unit_t* observer = nullptr;
			for (unit_t* unit : ptr(st.player_units[1])) if (functions.unit_is(unit, UnitTypes::Protoss_Observer)) observer = unit;
			require(observer && functions.u_cloaked(observer), "the original Observer retains its native permanent cloak");
			functions.u_set_status_flag(observer, unit_t::status_flag_invincible);
			xy original = observer->sprite->position;
			kerrigan->energy = fp8::integer(250);
			functions.set_secondary_order(kerrigan, functions.get_order_type(Orders::Cloak));
			functions.move_unit(observer, kerrigan->sprite->position + xy(64, 0));
			for (int tick = 0; tick != 96; ++tick) step();
			require(functions.u_cloaked(kerrigan) && functions.unit_can_see_target(observer, kerrigan), "Observer compatibility preserves native detection of a cloaked original Kerrigan");
			xy before = observer->sprite->position;
			functions.queue_order_back(observer, functions.get_order_type(Orders::Move), original);
			for (int tick = 0; tick != 64; ++tick) step();
			require(observer->sprite->position != before && observer->order_type->id == Orders::Move, "Observer AI idle services existing queued native movement");
		} else {
			unit_t* nexus = nullptr;
			for (unit_t* unit : ptr(st.player_units[1])) if (functions.unit_is(unit, UnitTypes::Protoss_Nexus)) nexus = unit;
			require(nexus, "original Nexus supplies the authored credited-kill dialogue fixture");
			auto approach = functions.find_unit_placement(kerrigan, nexus->sprite->position + xy(96, 0), false);
			require(approach.first, "native placement supplies a legal isolated Nexus combat approach");
			functions.move_unit(kerrigan, approach.second);
			functions.set_unit_order(kerrigan, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 64; ++tick) step();
			functions.set_unit_shield_points(nexus, 0_fp8);
			functions.set_unit_hp(nexus, 1_fp8);
			functions.issue_order(kerrigan, false, kerrigan->unit_type->attack_unit, {nexus->sprite->position, nexus});
			bool paused = false;
			for (int tick = 0; tick != 2000; ++tick) { step(); paused = paused || st.scripted_pause; }
			require(st.killed_unit_counts[3][UnitTypes::Protoss_Nexus] >= 1 && paused && !st.scripted_pause && !st.players[3].victory_state, "a credited native Nexus kill runs the original Kerrigan/Zeratul dialogue without prematurely winning");
		}
		printf("Eye for an Eye original mission case %d passed.\n", scenario);
	}
}

static void invasion_aiur_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 8; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[3])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (unit_t* unit : ptr(st.player_units[3])) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				if (functions.ut_building(unit) && !functions.unit_dying(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		unit_t* drone = nullptr;
		unit_t* hydralisk = nullptr;
		for (unit_t* unit : ptr(st.player_units[3])) {
			if (functions.unit_is(unit, UnitTypes::Zerg_Drone)) drone = unit;
			if (functions.unit_is(unit, UnitTypes::Zerg_Hydralisk)) hydralisk = unit;
		}
		require(drone && hydralisk && !st.countdown_active && !st.trigger_switches[0] && !st.unit_counts[3][UnitTypes::Powerup_Khaydarin_Crystal], "original mission begins before harvesting, with no manufactured portable crystal");
		if (scenario < 4) {
			unit_t* overlord = nullptr;
			for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Zerg_Overlord)) overlord = unit;
			require(overlord, "original Overlord supplies mission-9 contact-gate movement");
			int locations[] = {22, 24, 3, 4};
			const auto& area = st.locations.at(locations[scenario]).area;
			xy destination = (area.from + area.to) / 2;
			functions.move_unit(overlord, xy(destination.x, area.from.y - 64));
			functions.issue_order(overlord, false, functions.get_order_type(Orders::Move), {destination, nullptr});
			for (int tick = 0; tick != 800 && !st.trigger_switches[scenario == 1 ? 11 : 10]; ++tick) step();
			for (int tick = 0; tick != 64; ++tick) step();
			int owner = scenario == 1 ? 4 : 7;
			auto& ai = st.campaign_ai[owner];
			require(st.trigger_switches[scenario == 1 ? 11 : 10] && ai.town_active && ai.area_towns.size() == 1 && !st.players[3].victory_state, "native contact starts both original main/area-town programs without a replacement wave");
			require(!ai.valued_regions.empty(), "authored VluA programs mark original center regions for native regional defense");
			if (scenario == 0) {
				size_t selected = ~(size_t)0;
				for (const auto& value : ai.valued_regions) if (!ai.regions[value.index].owned && st.game->regions.regions.at(value.index).walkable()) { selected = value.index; break; }
				require(selected != ~(size_t)0, "source value-area list includes a walkable region without owned primary buildings");
				const auto& region = st.game->regions.regions.at(selected);
				xy position(region.center.x.integer_part(), region.center.y.integer_part());
				functions.move_unit(hydralisk, position);
				for (int tick = 0; tick != 64; ++tick) step();
				require(ai.regions[selected].defended && std::any_of(ai.defending.begin(), ai.defending.end(), [&](const auto& defender) { return defender.region == selected; }), "original defenseuse requests assign real native defenders to a valued-region incursion");
				functions.start_campaign_ai_script(owner, 1098214486u, functions.square_at(position, 16));
				for (int tick = 0; tick != 8; ++tick) step();
				require(std::count_if(ai.valued_regions.begin(), ai.valued_regions.end(), [&](const auto& value) { return value.index == selected; }) == 1, "repeated VluA execution cannot duplicate an already valued region");
				functions.move_unit(hydralisk, xy(638, 469));
				functions.update_campaign_ai_regions(owner);
				require(!ai.regions[selected].defended && std::none_of(ai.valued_regions.begin(), ai.valued_regions.end(), [&](const auto& value) { return value.index == selected; }), "a building-free valued region expires after its original one-defense lifecycle");
				size_t occupied = functions.get_region_at(hydralisk->sprite->position)->index;
				functions.start_campaign_ai_script(owner, 1098214486u, functions.square_at(hydralisk->sprite->position, 16));
				functions.start_campaign_ai_script(3, 2037135706u, st.locations.at(3).area);
				for (int tick = 0; tick != 8; ++tick) step();
				require(std::none_of(ai.valued_regions.begin(), ai.valued_regions.end(), [&](const auto& value) { return value.index == occupied; }) && !st.campaign_ai[3].town_active && st.campaign_ai[3].area_towns.empty(), "VluA ignores already occupied enemy regions and area-town programs cannot take over the human player");
				unit_t* building = nullptr;
				for (unit_t* unit : ptr(st.player_units[owner])) if (functions.u_grounded_building(unit) && !functions.unit_dying(unit)) { building = unit; break; }
				require(building, "original Protoss building supplies the persistent value-area case");
				size_t building_region = functions.get_region_at(building->sprite->position)->index;
				functions.start_campaign_ai_script(owner, 1098214486u, functions.square_at(building->sprite->position, 16));
				for (int tick = 0; tick != 8; ++tick) step();
				functions.move_unit(hydralisk, building->sprite->position);
				functions.update_campaign_ai_regions(owner);
				functions.move_unit(hydralisk, xy(638, 469));
				functions.update_campaign_ai_regions(owner);
				require(ai.regions[building_region].defended && std::any_of(ai.valued_regions.begin(), ai.valued_regions.end(), [&](const auto& value) { return value.index == building_region && value.contested; }), "a valued region with an original owned building remains eligible after an incursion ends");
			}
		} else if (scenario == 4) {
			functions.move_unit(hydralisk, xy(1872, 2912));
			functions.move_unit(drone, xy(528, 480));
			for (int tick = 0; tick != 800; ++tick) step();
			require(!st.countdown_active && !st.trigger_switches[0] && !st.unit_counts[3][UnitTypes::Powerup_Khaydarin_Crystal] && !st.players[3].victory_state, "a non-Drone at the formation and an empty Drone at the return beacon cannot start harvesting or win");
		} else if (scenario == 5) {
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[3])) if (!functions.unit_dying(unit)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
			for (int tick = 0; tick != 128 && !st.players[3].victory_state; ++tick) step();
			require(st.players[3].victory_state == 2, "the original whole-human-force loss reaches mission-9 defeat");
		} else {
			functions.move_unit(drone, xy(1792, 2912));
			functions.issue_order(drone, false, functions.get_order_type(Orders::Move), {xy(1872, 2912), nullptr});
			for (int tick = 0; tick != 1200 && !st.countdown_active; ++tick) step();
			require(st.countdown_active && st.countdown_timer == 600 && st.unit_counts[3][UnitTypes::Zerg_Drone] == 3 && !st.unit_counts[3][UnitTypes::Powerup_Khaydarin_Crystal], "normal Drone movement starts source removal, harvest dialogue and the full ten-minute timer without creating a crystal early");
			int harvesting_frame = st.current_frame;
			for (int tick = 0; tick != 600 * 16 && st.countdown_timer > 1; ++tick) step();
			require(st.countdown_timer == 1 && st.current_frame - harvesting_frame >= 598 * 16 && !st.unit_counts[3][UnitTypes::Powerup_Khaydarin_Crystal] && !st.players[3].victory_state, "the unshortened source harvest cannot finish or win before countdown expiry");
			unit_t* crystal = nullptr;
			unit_t* carrier = nullptr;
			for (int tick = 0; tick != 1200 && !carrier; ++tick) {
				step();
				for (unit_t* unit : ptr(st.player_units[3])) {
					if (functions.unit_is(unit, UnitTypes::Powerup_Khaydarin_Crystal) && !functions.unit_dying(unit)) crystal = unit;
					if (functions.ut_worker(unit) && unit->worker.powerup) carrier = unit;
				}
			}
			require(st.trigger_switches[0] && crystal && carrier && carrier->worker.powerup == crystal && functions.us_hidden(crystal) && carrier->carrying_flags == 4 && st.unit_counts[3][UnitTypes::Zerg_Drone] == 4 && !st.players[3].victory_state, "source expiry recreates the Drone and exactly its native carried crystal without premature victory");
			if (scenario == 7) {
				unit_id crystal_id = functions.get_unit_id(crystal);
				functions.kill_unit(carrier);
				for (int tick = 0; tick != 64; ++tick) step();
				crystal = functions.get_unit(crystal_id);
				require(crystal && !functions.unit_dying(crystal) && !functions.us_hidden(crystal) && !st.players[3].victory_state, "native carrier loss drops the same crystal without inventing defeat or another harvest");
				carrier = nullptr;
				for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Zerg_Drone) && !functions.unit_dying(unit)) carrier = unit;
				require(carrier, "another original Drone remains for crystal recovery");
				functions.issue_order(carrier, false, functions.get_order_type(Orders::Move), {crystal->sprite->position, nullptr});
				for (int tick = 0; tick != 8000 && !carrier->worker.powerup; ++tick) step();
				require(carrier->worker.powerup == crystal && functions.us_hidden(crystal) && !st.countdown_timer, "an original Drone can walk to recover the same dropped crystal without resetting harvesting");
			}
			functions.issue_order(carrier, false, functions.get_order_type(Orders::Move), {xy(528, 480), nullptr});
			for (int tick = 0; tick != 8000 && !st.players[3].victory_state; ++tick) step();
			require(st.players[3].victory_state >= 3 && carrier->worker.powerup == crystal, "normal native crystal delivery runs the original transmission and victory with enemy bases still present");
		}
		printf("The Invasion of Aiur original mission case %d passed.\n", scenario);
	}
}

static void full_circle_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 6; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[3])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (unit_t* unit : ptr(st.player_units[3])) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				if (functions.ut_building(unit) && !functions.unit_dying(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		unit_t* temple = nullptr;
		unit_t* drone = nullptr;
		unit_t* hydralisk = nullptr;
		for (unit_t* unit : ptr(st.player_units[0])) if (functions.unit_is(unit, UnitTypes::Special_Protoss_Temple)) temple = unit;
		for (unit_t* unit : ptr(st.player_units[3])) {
			if (functions.unit_is(unit, UnitTypes::Zerg_Drone)) drone = unit;
			if (functions.unit_is(unit, UnitTypes::Zerg_Hydralisk)) hydralisk = unit;
		}
		require(temple && drone && hydralisk && !st.unit_counts[3][UnitTypes::Powerup_Khaydarin_Crystal], "Full Circle begins with the original Temple and no early portable crystal");
		if (scenario == 0) {
			functions.move_unit(drone, xy(1904, 2064));
			for (int tick = 0; tick != 800; ++tick) step();
			require(st.unit_counts[0][UnitTypes::Special_Protoss_Temple] == 1 && !st.unit_counts[3][UnitTypes::Powerup_Khaydarin_Crystal] && !st.players[3].victory_state, "idle play and an empty Drone at the foundation cannot bypass Temple destruction or crystal delivery");
		} else if (scenario == 1) {
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[3])) if (!functions.unit_dying(unit)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
			for (int tick = 0; tick != 128 && !st.players[3].victory_state; ++tick) step();
			require(st.players[3].victory_state == 2, "the original whole-human-force loss reaches Full Circle defeat");
		} else if (scenario == 2 || scenario == 3) {
			unit_t* victim = temple;
			if (scenario == 2) {
				victim = nullptr;
				for (unit_t* unit : ptr(st.player_units[0])) if (functions.unit_is(unit, UnitTypes::Protoss_Probe)) victim = unit;
			}
			require(victim, "an original Red actor supplies the authored activation fixture");
			functions.kill_unit(victim);
			for (int tick = 0; tick != 800; ++tick) step();
			require(st.trigger_switches[10] && st.campaign_ai[0].town_active && st.campaign_ai_scripts.size() == 5 && !st.campaign_ai[3].town_active, "the original Red casualty or Temple-loss gate starts Z10e without a replacement wave");
			require(!st.killed_unit_counts[3][UnitTypes::Special_Protoss_Temple] && !st.unit_counts[3][UnitTypes::Powerup_Khaydarin_Crystal] && !st.players[3].victory_state, "an uncredited loss cannot fabricate the source human Temple-kill condition or final victory");
			if (scenario == 2) require(st.unit_counts[0][UnitTypes::Special_Protoss_Temple] == 1, "Red activation from an ordinary casualty does not remove the Temple");
		} else {
			auto approach = functions.find_unit_placement(hydralisk, temple->sprite->position + xy(160, 0), false);
			require(approach.first, "native placement supplies a legal isolated Temple combat approach");
			functions.move_unit(hydralisk, approach.second);
			functions.set_unit_shield_points(temple, 0_fp8);
			functions.set_unit_hp(temple, fp8::integer(1));
			functions.issue_order(hydralisk, false, hydralisk->unit_type->attack_unit, {temple->sprite->position, temple});
			for (int tick = 0; tick != 1200 && !st.killed_unit_counts[3][UnitTypes::Special_Protoss_Temple]; ++tick) step();
			require(st.killed_unit_counts[3][UnitTypes::Special_Protoss_Temple] == 1 && !st.players[3].victory_state, "a real native Hydralisk weapon kill supplies source Temple credit without immediately winning");
			int temple_killed_frame = st.current_frame;
			unit_t* crystal = nullptr;
			unit_t* carrier = nullptr;
			for (int tick = 0; tick != 1600; ++tick) {
				step();
				for (unit_t* unit : ptr(st.player_units[3])) {
					if (functions.unit_is(unit, UnitTypes::Powerup_Khaydarin_Crystal) && !functions.unit_dying(unit)) crystal = unit;
					if (functions.ut_worker(unit) && unit->worker.powerup) carrier = unit;
				}
				if (crystal && !st.scripted_pause) break;
			}
			require(st.current_frame > temple_killed_frame && !st.scripted_pause && crystal && st.unit_counts[3][UnitTypes::Zerg_Drone] == 4 && st.unit_counts[3][UnitTypes::Powerup_Khaydarin_Crystal] == 1 && !st.players[3].victory_state, "the original unpaused Daggoth sequence creates exactly its Drone and crystal without prematurely winning");
			if (!carrier) {
				for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Zerg_Drone) && functions.is_in_bounds(unit->sprite->position, st.locations.at(0).area)) carrier = unit;
				require(carrier, "the source-created Drone remains within the original crystal arrival zone");
				functions.issue_order(carrier, false, functions.get_order_type(Orders::Move), {crystal->sprite->position, nullptr});
				for (int tick = 0; tick != 400 && !carrier->worker.powerup; ++tick) step();
			}
			require(carrier->worker.powerup == crystal && functions.us_hidden(crystal) && carrier->carrying_flags == 4, "normal native movement picks up the source-created crystal without a direct carry assignment");
			for (int tick = 0; tick != 96; ++tick) step();
			require(!st.players[3].victory_state && st.trigger_switches[10] && st.campaign_ai[0].town_active, "Temple destruction activates the original final offensive but does not bypass crystal delivery");
			if (scenario == 5) {
				unit_id crystal_id = functions.get_unit_id(crystal);
				functions.kill_unit(carrier);
				for (int tick = 0; tick != 64; ++tick) step();
				crystal = functions.get_unit(crystal_id);
				require(crystal && !functions.unit_dying(crystal) && !functions.us_hidden(crystal) && !st.players[3].victory_state, "carrier loss drops the same original crystal without inventing defeat or a duplicate");
				carrier = nullptr;
				for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Zerg_Drone) && !functions.unit_dying(unit)) carrier = unit;
				require(carrier, "an original starting Drone remains to recover the dropped crystal");
				functions.issue_order(carrier, false, functions.get_order_type(Orders::Move), {crystal->sprite->position, nullptr});
				for (int tick = 0; tick != 4000 && !carrier->worker.powerup; ++tick) step();
				require(carrier->worker.powerup == crystal && functions.us_hidden(crystal), "an original Drone can recover the same dropped crystal through native pickup");
			}
			const auto& foundation = st.locations.at(1).area;
			functions.issue_order(carrier, false, functions.get_order_type(Orders::Move), {(foundation.from + foundation.to) / 2, nullptr});
			bool ending_paused = false;
			for (int tick = 0; tick != 18000 && !st.players[3].victory_state; ++tick) { step(); ending_paused = ending_paused || st.scripted_pause; }
			require(ending_paused && st.players[3].victory_state >= 3 && carrier->worker.powerup == crystal && st.building_counts[0] + st.building_counts[2] + st.building_counts[7] > 0, "native crystal delivery runs the original paused Overmind ending and victory while other Protoss buildings remain");
		}
		printf("Full Circle original mission case %d passed.\n", scenario);
	}
}

static void first_strike_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 5; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (int owner : {1, 2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				if (functions.ut_building(unit) && !functions.unit_dying(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		if (scenario == 0) {
			unit_t* fenix = nullptr;
			for (unit_t* unit : ptr(st.player_units[2])) if (functions.unit_is(unit, UnitTypes::Hero_Fenix_Zealot)) fenix = unit;
			require(fenix, "the original rescuable Fenix supplies the survival objective");
			functions.kill_unit(fenix);
			for (int tick = 0; tick != 300 && !st.players[7].victory_state; ++tick) step();
			require(st.players[7].victory_state == 2, "Fenix loss before rescue runs the original paused defeat sequence");
		} else if (scenario == 1) {
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[7])) if (!functions.unit_dying(unit)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
			for (int tick = 0; tick != 128 && !st.players[7].victory_state; ++tick) step();
			require(st.players[7].victory_state == 2, "loss of the original human army reaches First Strike defeat");
		} else if (scenario == 2 || scenario == 3) {
			unit_t* remaining = nullptr;
			for (unit_t* unit : ptr(st.player_units[0])) if (functions.ut_building(unit)) remaining = unit;
			require(remaining, "original Zerg buildings supply the victory predicate fixture");
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[0])) if (functions.ut_building(unit) && (scenario == 3 || unit != remaining)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
			bool ending_paused = false;
			for (int tick = 0; tick != 2000 && !st.players[7].victory_state; ++tick) { step(); ending_paused = ending_paused || st.scripted_pause; }
			if (scenario == 2) require(!st.players[7].victory_state && st.building_counts[0] == 1, "one surviving original Zerg building blocks the source victory");
			else require(ending_paused && st.players[7].victory_state >= 3 && st.non_building_counts[0] > 0, "all original Zerg buildings gone runs the paused Fenix ending and victory even with mobile enemies remaining");
		} else {
			unit_t* dragoon = nullptr;
			for (unit_t* unit : ptr(st.player_units[7])) if (functions.unit_is(unit, UnitTypes::Protoss_Dragoon)) dragoon = unit;
			require(dragoon, "an original Dragoon supplies normal First Strike rescue movement");
			functions.issue_order(dragoon, false, functions.get_order_type(Orders::Move), {xy(1271, 1853), nullptr});
			for (int tick = 0; tick != 4000 && !st.unit_counts[7][UnitTypes::Protoss_Nexus]; ++tick) step();
			require(st.unit_counts[7][UnitTypes::Hero_Fenix_Zealot] == 1 && st.unit_counts[7][UnitTypes::Protoss_Nexus] == 1 && st.unit_counts[7][UnitTypes::Protoss_Gateway] == 1 && !st.unit_counts[1][UnitTypes::Protoss_Nexus] && !st.unit_counts[2][UnitTypes::Hero_Fenix_Zealot], "normal native movement rescues Fenix and the original trigger-created Observer naturally rescues Antioch");
			for (int tick = 0; tick != 600; ++tick) step();
			require(!st.unit_counts[7][UnitTypes::Protoss_Observer] && !st.unit_counts[7][UnitTypes::Protoss_Probe] && !st.players[7].victory_state && st.current_minerals[7] == 400 && st.current_gas[7] == 100, "source cleanup removes its temporary Observer while retaining original resources and the no-Probe economy objective");
		}
		printf("First Strike original mission case %d passed.\n", scenario);
	}
}

static void into_flames_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 5; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (int owner : {2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				if (functions.ut_building(unit) && !functions.unit_dying(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		unit_t* cerebrate = nullptr;
		for (unit_t* unit : ptr(st.player_units[6])) if (functions.unit_is(unit, UnitTypes::Special_Cerebrate)) cerebrate = unit;
		require(cerebrate && !st.trigger_switches[4] && !st.unit_counts[7][UnitTypes::Hero_Fenix_Zealot] && !st.unit_counts[2][UnitTypes::Hero_Fenix_Zealot], "Into the Flames begins with its original Cerebrate and no premature Fenix");
		if (scenario == 0) {
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[7])) if (!functions.unit_dying(unit)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
			for (int tick = 0; tick != 128 && !st.players[7].victory_state; ++tick) step();
			require(st.players[7].victory_state == 2, "whole-human-force loss reaches the original Into the Flames defeat");
		} else if (scenario == 1) {
			functions.kill_unit(cerebrate);
			bool ending_paused = false;
			for (int tick = 0; tick != 1500 && !st.players[7].victory_state; ++tick) { step(); ending_paused = ending_paused || st.scripted_pause; }
			require(ending_paused && st.players[7].victory_state >= 3 && st.building_counts[6] > 0 && !st.trigger_switches[4], "the original Cerebrate predicate permits its paused ending before arrival without requiring every Zerg building to die");
		} else if (scenario == 2) {
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[6])) if (functions.ut_building(unit) && unit != cerebrate) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
			for (int tick = 0; tick != 800; ++tick) step();
			require(!st.players[7].victory_state && st.unit_counts[6][UnitTypes::Special_Cerebrate] == 1 && !st.trigger_switches[4], "a living original Cerebrate blocks victory and absent pre-arrival Fenix does not cause defeat");
		} else {
			functions.u_set_status_flag(cerebrate, unit_t::status_flag_invincible);
			while (st.countdown_timer > 1) step();
			require(st.current_frame >= 899 * 16 && !st.trigger_switches[4] && !st.unit_counts[7][UnitTypes::Hero_Fenix_Zealot] && !st.unit_counts[2][UnitTypes::Hero_Fenix_Zealot] && !st.unit_counts[7][UnitTypes::Protoss_Reaver] && !st.players[7].victory_state, "the full unshortened fifteen-minute source countdown cannot create Fenix or his strike force early");
			int initial_dragoons = st.unit_counts[7][UnitTypes::Protoss_Dragoon];
			int initial_zealots = st.unit_counts[7][UnitTypes::Protoss_Zealot];
			for (int tick = 0; tick != 1000 && !st.trigger_switches[4]; ++tick) step();
			require(st.trigger_switches[4] && st.unit_counts[7][UnitTypes::Protoss_Dragoon] == initial_dragoons + 5 && st.unit_counts[7][UnitTypes::Protoss_Zealot] == initial_zealots + 5 && st.unit_counts[7][UnitTypes::Protoss_Reaver] == 3 && st.unit_counts[7][UnitTypes::Hero_Fenix_Zealot] + st.unit_counts[2][UnitTypes::Hero_Fenix_Zealot] == 1 && !st.players[7].victory_state, "source expiry creates exactly five Dragoons, five Zealots, three Reavers and one original Fenix before subsequent combat");
			for (int tick = 0; tick != 256; ++tick) step();
			unit_t* fenix = nullptr;
			unit_t* reaver = nullptr;
			for (unit_t* unit : ptr(st.player_units[7])) {
				if (functions.unit_is(unit, UnitTypes::Hero_Fenix_Zealot)) fenix = unit;
				if (functions.unit_is(unit, UnitTypes::Protoss_Reaver)) reaver = unit;
			}
			for (unit_t* unit : ptr(st.player_units[2])) if (functions.unit_is(unit, UnitTypes::Hero_Fenix_Zealot)) fenix = unit;
			require(fenix && reaver, "the original source-created hero and Reaver remain live");
			if (fenix->owner == 2) {
				unit_t* escort = nullptr;
				for (unit_t* unit : ptr(st.player_units[7])) if (functions.unit_is(unit, UnitTypes::Protoss_Zealot) && (!escort || functions.xy_length(unit->sprite->position - fenix->sprite->position) < functions.xy_length(escort->sprite->position - fenix->sprite->position))) escort = unit;
				require(escort, "a source-created Zealot can approach the original rescuable Fenix");
				functions.issue_order(escort, false, functions.get_order_type(Orders::Move), {fenix->sprite->position, nullptr});
				for (int tick = 0; tick != 800 && fenix->owner != 7; ++tick) step();
			}
			require(fenix->owner == 7 && st.unit_counts[7][UnitTypes::Hero_Fenix_Zealot] == 1, "normal strike-force proximity naturally rescues the source-created Fenix");
			if (scenario == 4) {
				functions.kill_unit(fenix);
				for (int tick = 0; tick != 400 && !st.players[7].victory_state; ++tick) step();
				require(st.players[7].victory_state == 2, "Fenix loss after source arrival enables the original paused defeat");
			} else {
				functions.set_unit_order(reaver, functions.get_order_type(Orders::Nothing));
				require(!functions.unit_scarab_count(reaver), "the source does not invent loaded Scarabs for its Reavers");
				action_state player_commands;
				action_functions actions(st, player_commands);
				require(actions.action_select(7, reaver) && actions.action_train_fighter(7), "the original Reaver accepts normal paid Scarab production");
				for (int tick = 0; tick != 600 && !functions.unit_scarab_count(reaver); ++tick) step();
				require(functions.unit_scarab_count(reaver) == 1 && st.current_minerals[7] == 155 && !st.current_gas[7], "native Scarab production charges fifteen original minerals and fills actual ammunition");
				auto approach = functions.find_unit_placement(reaver, cerebrate->sprite->position + xy(160, 0), false);
				require(approach.first, "native placement supplies an isolated Reaver combat approach");
				functions.move_unit(reaver, approach.second);
				for (int tick = 0; tick != 64; ++tick) step();
				functions.u_unset_status_flag(cerebrate, unit_t::status_flag_invincible);
				functions.set_unit_hp(cerebrate, fp8::integer(1));
				functions.issue_order(reaver, false, reaver->unit_type->attack_unit, {cerebrate->sprite->position, cerebrate});
				bool scarab_launched = false, ending_paused = false;
				for (int tick = 0; tick != 2000 && !st.players[7].victory_state; ++tick) { step(); scarab_launched = scarab_launched || reaver->reaver.outside_count > 0; ending_paused = ending_paused || st.scripted_pause; }
				require(scarab_launched && st.killed_unit_counts[7][UnitTypes::Special_Cerebrate] == 1 && ending_paused && st.players[7].victory_state >= 3, "a paid native Scarab launches, kills the original Cerebrate and reaches the source paused Fenix ending");
			}
		}
		printf("Into the Flames original mission case %d passed.\n", scenario);
	}
}

static void higher_ground_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 4; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (unit_t* unit : ptr(st.player_units[7])) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				if (functions.ut_building(unit) && !functions.unit_dying(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		if (scenario == 0) {
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[7])) if (!functions.unit_dying(unit)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
			for (int tick = 0; tick != 128 && !st.players[7].victory_state; ++tick) step();
			require(st.players[7].victory_state == 2, "whole-human-force loss reaches the original Higher Ground defeat");
		} else {
			a_vector<unit_t*> victims;
			for (int owner : {0, 6}) {
				if ((scenario == 1 && owner != 0) || (scenario == 2 && owner != 6)) continue;
				for (unit_t* unit : ptr(st.player_units[owner])) if (functions.ut_building(unit)) victims.push_back(unit);
			}
			for (unit_t* unit : victims) functions.kill_unit(unit);
			bool ending_paused = false;
			for (int tick = 0; tick != 2000 && !st.players[7].victory_state; ++tick) { step(); ending_paused = ending_paused || st.scripted_pause; }
			if (scenario != 3) require(!st.players[7].victory_state && st.building_counts[scenario == 1 ? 6 : 0] > 0, "either surviving original Zerg colony blocks Higher Ground victory");
			else require(ending_paused && !st.scripted_pause && st.players[7].victory_state >= 3 && st.non_building_counts[0] + st.non_building_counts[6] > 0, "both original hostile building forces gone runs the paused Fenix/Aldaris dialogue, unpauses and wins with mobile enemies remaining");
		}
		printf("Higher Ground original mission case %d passed.\n", scenario);
	}
}

static void hunt_tassadar_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 6; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (int owner : {1, 2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				if (functions.ut_building(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		unit_t* tassadar = nullptr;
		unit_t* raynor = nullptr;
		unit_t* escort = nullptr;
		for (unit_t* unit : ptr(st.player_units[2])) {
			if (functions.unit_is(unit, UnitTypes::Hero_Tassadar)) tassadar = unit;
			if (functions.unit_is(unit, UnitTypes::Hero_Jim_Raynor_Vulture)) raynor = unit;
		}
		for (unit_t* unit : ptr(st.player_units[7])) if (functions.unit_is(unit, UnitTypes::Protoss_Dragoon)) escort = unit;
		require(tassadar && raynor && escort && !st.trigger_switches[0], "original Tassadar and source-created Raynor remain rescuable before the meeting");
		if (scenario < 3) {
			if (scenario == 0) {
				a_vector<unit_t*> victims;
				for (unit_t* unit : ptr(st.player_units[7])) if (!functions.unit_dying(unit)) victims.push_back(unit);
				for (unit_t* unit : victims) functions.kill_unit(unit);
			} else functions.kill_unit(scenario == 1 ? tassadar : raynor);
			for (int tick = 0; tick != 1000 && !st.players[7].victory_state; ++tick) step();
			require(st.players[7].victory_state == 2, "original human-force or required-hero loss reaches The Hunt for Tassadar defeat");
		} else if (scenario == 3) {
			a_vector<unit_t*> victims;
			for (int owner : {0, 3}) for (unit_t* unit : ptr(st.player_units[owner])) if (functions.ut_building(unit) && !functions.unit_dying(unit)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
			for (int tick = 0; tick != 800; ++tick) step();
			require(!st.players[7].victory_state && !st.trigger_switches[0] && !st.unit_counts[7][UnitTypes::Hero_Tassadar] && !st.unit_counts[7][UnitTypes::Hero_Jim_Raynor_Vulture], "clearing enemy buildings and ordinary troops at the starting beacon cannot replace the original two-hero objective");
		} else {
			unit_id tassadar_id = functions.get_unit_id(tassadar), raynor_id = functions.get_unit_id(raynor);
			auto approach = functions.find_unit_placement(escort, tassadar->sprite->position + xy(160, 0), false);
			require(approach.first, "native placement supplies an isolated approach to the original rescue region");
			functions.move_unit(escort, approach.second);
			functions.issue_order(escort, false, functions.get_order_type(Orders::Move), {raynor->sprite->position, nullptr});
			bool meeting_paused = false;
			for (int tick = 0; tick != 6000 && !(st.trigger_switches[1] && !st.scripted_pause && st.campaign_ai[0].town_active); ++tick) { step(); meeting_paused = meeting_paused || st.scripted_pause; }
			tassadar = functions.get_unit(tassadar_id);
			raynor = functions.get_unit(raynor_id);
			require(tassadar && raynor && tassadar->owner == 7 && raynor->owner == 7 && meeting_paused && !st.scripted_pause && st.trigger_switches[0] && st.trigger_switches[1] && st.campaign_ai[0].town_active && !st.campaign_ai[7].town_active && !st.players[7].victory_state, "native proximity rescues the same heroes and runs the full source meeting before Pro4 activation");
			require(st.current_minerals[7] == 50 && st.current_gas[7] == 0 && st.unit_counts[0][UnitTypes::Zerg_Overlord] >= 19, "the original meeting grants only fifty minerals and runs the authored Zerg reinforcement actions");
			functions.issue_order(escort, false, functions.get_order_type(Orders::Move), {xy(736, 496), nullptr});
			for (int tick = 0; tick != 1000 && !st.unit_counts[7][UnitTypes::Protoss_Nexus]; ++tick) step();
			require(st.unit_counts[7][UnitTypes::Protoss_Nexus] == 1 && st.unit_counts[7][UnitTypes::Protoss_Probe] == 4 && !st.unit_counts[1][UnitTypes::Protoss_Nexus], "ordinary proximity naturally rescues the original base and four Probes without grants");
			functions.u_set_status_flag(tassadar, unit_t::status_flag_invincible);
			functions.u_set_status_flag(raynor, unit_t::status_flag_invincible);
			functions.set_unit_order(tassadar, functions.get_order_type(Orders::HoldPosition));
			functions.set_unit_order(raynor, functions.get_order_type(Orders::HoldPosition));
			if (scenario == 4) {
				bool ground_fire = false, air_fire = false;
				int combat_budget = 4502 + 4 * (500 + 180 * 15) + 2 * functions.get_unit_type(UnitTypes::Zerg_Mutalisk)->build_time + st.game->map_width;
				for (int tick = 0; tick != combat_budget && !(ground_fire && air_fire); ++tick) {
					step();
					for (unit_id id : st.campaign_ai[0].attacking) {
						unit_t* unit = functions.get_unit(id);
						if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
						if (!unit->ground_weapon_cooldown && !unit->air_weapon_cooldown) continue;
						if (functions.u_flying(unit)) air_fire = true;
						else ground_fire = true;
					}
				}
				require(ground_fire && air_fire, "original Pro4 ground and Mutalisk parties fire native weapons at authored waits and funding");
				printf("The Hunt for Tassadar original Pro4 ground and air attacks passed.\n");
			}
			unit_t* first = scenario == 4 ? tassadar : raynor;
			unit_t* second = scenario == 4 ? raynor : tassadar;
			const auto& beacon = st.locations.at(0).area;
			xy destination = (beacon.from + beacon.to) / 2;
			functions.issue_order(first, false, functions.get_order_type(Orders::Move), {destination, nullptr});
			for (int tick = 0; tick != 10000 && !functions.is_in_bounds(first->sprite->position, beacon); ++tick) step();
			require(functions.is_in_bounds(first->sprite->position, beacon) && !st.players[7].victory_state, "either original hero arriving alone cannot satisfy the source paired Bring conditions");
			functions.set_unit_order(first, functions.get_order_type(Orders::HoldPosition));
			functions.issue_order(second, false, functions.get_order_type(Orders::Move), {destination, nullptr});
			bool ending_paused = false;
			for (int tick = 0; tick != 12000 && !st.players[7].victory_state; ++tick) { step(); ending_paused = ending_paused || st.scripted_pause; }
			require(ending_paused && st.players[7].victory_state >= 3 && st.building_counts[0] > 0, "normal native movement of both original heroes runs the source paused ending and victory with the Zerg base intact");
		}
		printf("The Hunt for Tassadar original mission case %d passed.\n", scenario);
	}
}

static void choosing_sides_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 7; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (unit_t* unit : ptr(st.player_units[7])) if (!functions.unit_dying(unit)) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		unit_t* tassadar = nullptr;
		unit_t* shuttle = nullptr;
		unit_t* dragoon = nullptr;
		a_vector<unit_t*> zealots;
		for (unit_t* unit : ptr(st.player_units[7])) {
			if (functions.unit_is(unit, UnitTypes::Hero_Tassadar)) tassadar = unit;
			if (functions.unit_is(unit, UnitTypes::Protoss_Shuttle)) shuttle = unit;
			if (functions.unit_is(unit, UnitTypes::Protoss_Dragoon)) dragoon = unit;
			if (functions.unit_is(unit, UnitTypes::Protoss_Zealot)) zealots.push_back(unit);
		}
		require(tassadar && shuttle && dragoon && zealots.size() == 4 && !st.trigger_switches[0], "original Choosing Sides actors and naturally rescued Tassadar begin before the confrontation");
		if (scenario < 2) {
			if (scenario == 0) {
				a_vector<unit_t*> victims;
				for (unit_t* unit : ptr(st.player_units[7])) if (!functions.unit_dying(unit)) victims.push_back(unit);
				for (unit_t* unit : victims) functions.kill_unit(unit);
			} else functions.kill_unit(tassadar);
			for (int tick = 0; tick != 1000 && !st.players[7].victory_state; ++tick) step();
			require(st.players[7].victory_state == 2, "original human-force or Tassadar loss reaches Choosing Sides defeat");
		} else if (scenario < 4) {
			if (scenario == 2) {
				a_vector<unit_t*> victims;
				for (int owner : {3, 4}) for (unit_t* unit : ptr(st.player_units[owner])) if (functions.ut_building(unit) && !functions.unit_dying(unit)) victims.push_back(unit);
				for (unit_t* unit : victims) functions.kill_unit(unit);
				for (int tick = 0; tick != 128; ++tick) step();
				require(!st.players[7].victory_state, "clearing both Zerg colonies cannot replace the original installation entrance objective");
			}
			a_vector<unit_t*> passengers{tassadar, zealots[0], scenario == 2 ? dragoon : zealots[1]};
			for (unit_t* passenger : passengers) {
				functions.issue_order(passenger, false, functions.get_order_type(Orders::EnterTransport), {shuttle->sprite->position, shuttle});
				for (int tick = 0; tick != 1200 && !functions.us_hidden(passenger); ++tick) step();
				require(functions.us_hidden(passenger), "original Tassadar and escort board the original Shuttle through native loading");
			}
			const auto& entrance = st.locations.at(1).area;
			xy destination = (entrance.from + entrance.to) / 2;
			bool landing_found = false;
			for (int map_y = entrance.from.y + 32; map_y < entrance.to.y - 32 && !landing_found; map_y += 16) {
				for (int map_x = entrance.from.x + 32; map_x < entrance.to.x - 32 && !landing_found; map_x += 16) {
					xy candidate(map_x, map_y);
					bool fits = true;
					for (unit_t* passenger : passengers) for (int offset_y = -16; offset_y <= 16; offset_y += 16) for (int offset_x = -16; offset_x <= 16; offset_x += 16) {
						if (!functions.unit_type_can_fit_at(passenger->unit_type, candidate + xy(offset_x, offset_y))) fits = false;
					}
					if (fits) { destination = candidate; landing_found = true; }
				}
			}
			require(landing_found, "native terrain footprints provide a legal landing point inside the original entrance region");
			functions.issue_order(shuttle, false, functions.get_order_type(Orders::Move), {destination, nullptr});
			for (int tick = 0; tick != 6000 && !functions.is_in_bounds(shuttle->sprite->position, entrance); ++tick) step();
			functions.set_unit_order(shuttle, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 96; ++tick) step();
			require(functions.is_in_bounds(shuttle->sprite->position, entrance) && functions.us_hidden(tassadar) && !st.players[7].victory_state, "native Shuttle flight over the ground-only entrance with loaded heroes and escorts cannot win");
			functions.issue_order(shuttle, false, functions.get_order_type(Orders::MoveUnload), {destination, nullptr});
			a_vector<bool> disembarked(passengers.size());
			for (int tick = 0; tick != 1600 && !st.players[7].victory_state; ++tick) {
				step();
				for (size_t index = 0; index != passengers.size(); ++index) {
					unit_t* passenger = passengers[index];
					if (functions.us_hidden(passenger)) continue;
					if (!disembarked[index]) {
						disembarked[index] = true;
						functions.issue_order(passenger, false, functions.get_order_type(Orders::Move), {destination, nullptr});
					}
					if (functions.is_in_bounds(passenger->sprite->position, entrance)) functions.set_unit_order(passenger, functions.get_order_type(Orders::HoldPosition));
				}
			}
			for (unit_t* passenger : passengers) require(!functions.us_hidden(passenger) && functions.is_in_bounds(passenger->sprite->position, entrance), "native unloading puts the original transported actors on the entrance island");
			if (scenario == 2) require(!st.players[7].victory_state, "Tassadar with one Zealot and a Dragoon cannot satisfy the source requirement for two Zealots");
			else require(st.players[7].victory_state >= 3 && st.building_counts[3] + st.building_counts[4] > 0 && functions.u_invincible(tassadar), "native delivery of Tassadar and two Zealots runs the source protection, wait and victory with Zerg bases intact");
		} else {
			if (scenario == 4) {
				unit_t* depot = nullptr;
				for (unit_t* unit : ptr(st.player_units[6])) if (functions.unit_is(unit, UnitTypes::Terran_Supply_Depot)) depot = unit;
				require(depot, "an original Terran depot supplies the source casualty gate");
				functions.kill_unit(depot);
			} else {
				const auto& airspace = st.locations.at(scenario == 5 ? 3 : 4).area;
				functions.issue_order(shuttle, false, functions.get_order_type(Orders::Move), {(airspace.from + airspace.to) / 2, nullptr});
			}
			bool confrontation_paused = false, original_wraiths = false, original_battlecruiser = false, revealer = false;
			for (int tick = 0; tick != 6000 && !(st.trigger_switches[4] && !st.scripted_pause); ++tick) {
				step();
				confrontation_paused = confrontation_paused || st.scripted_pause;
				original_wraiths = original_wraiths || st.unit_counts[6][UnitTypes::Terran_Wraith] == 9;
				original_battlecruiser = original_battlecruiser || st.unit_counts[6][UnitTypes::Terran_Battlecruiser] == 1;
				revealer = revealer || st.unit_counts[7][UnitTypes::Special_Map_Revealer] > 0;
			}
			for (int tick = 0; tick != 400; ++tick) step();
			require(st.trigger_switches[0] && st.trigger_switches[4] && confrontation_paused && !st.scripted_pause && original_wraiths && original_battlecruiser && revealer && !st.unit_counts[7][UnitTypes::Special_Map_Revealer] && !st.players[7].victory_state, "each original casualty/airspace gate runs Duke's paused dialogue, exact reinforcements, revealer cleanup and native suicide activation without winning");
		}
		printf("Choosing Sides original mission case %d passed.\n", scenario);
	}
}

static void into_darkness_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 9; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (unit_t* unit : ptr(st.player_units[7])) if (!functions.unit_dying(unit)) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		unit_t* tassadar = nullptr;
		unit_t* zealot = nullptr;
		unit_t* zeratul = nullptr;
		for (unit_t* unit : ptr(st.player_units[7])) {
			if (functions.unit_is(unit, UnitTypes::Hero_Tassadar)) tassadar = unit;
			if (functions.unit_is(unit, UnitTypes::Protoss_Zealot)) zealot = unit;
		}
		for (unit_t* unit : ptr(st.player_units[2])) if (functions.unit_is(unit, UnitTypes::Hero_Zeratul)) zeratul = unit;
		require(tassadar && zealot && zeratul, "original Tassadar is naturally rescued while the same original Zeratul remains to be found");
		auto location_center = [&](int location) { const auto& area = st.locations.at(location - 1).area; return (area.from + area.to) / 2; };
		auto approach_location = [&](unit_t* unit, int location) {
			xy destination = location_center(location);
			functions.move_unit(unit, destination);
			auto placement = functions.find_unit_placement(unit, destination, true);
			require(placement.first, "native terrain supplies a legal isolated source-region approach");
			functions.move_unit(unit, placement.second);
			functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		};
		if (scenario < 2) {
			if (scenario == 0) functions.kill_unit(tassadar);
			else {
				a_vector<unit_t*> victims;
				for (unit_t* unit : ptr(st.player_units[7])) if (!functions.unit_dying(unit)) victims.push_back(unit);
				for (unit_t* unit : victims) functions.kill_unit(unit);
			}
			for (int tick = 0; tick != 1000 && !st.players[7].victory_state; ++tick) step();
			require(st.players[7].victory_state == 2, "original Tassadar or whole-human-force loss reaches Into the Darkness defeat");
		} else if (scenario < 5) {
			int door_location = scenario == 2 ? 1 : scenario == 3 ? 8 : 16;
			unit_t* door = nullptr;
			for (unit_t* unit : functions.find_units(st.locations.at(door_location - 1).area)) if (functions.unit_is_door(unit)) door = unit;
			require(door && !functions.u_no_collide(door) && !functions.u_disabled(door), "the original auto/security/cell door begins physically closed");
			approach_location(zealot, door_location);
			if (scenario != 2) {
				for (int tick = 0; tick != 160; ++tick) step();
				require(!functions.u_no_collide(door) && !st.trigger_switches[scenario == 3 ? 1 : 5], "a locked original security door cannot open before its separate control trigger");
				approach_location(zealot, scenario == 3 ? 28 : 30);
			}
			for (int tick = 0; tick != 400; ++tick) step();
			require(functions.u_no_collide(door) && functions.u_disabled(door), "the original auto/control trigger opens its native door even when its placement owner is unused");
			if (scenario != 2) require(st.trigger_switches[scenario == 3 ? 1 : 5] && !st.unit_counts[7][UnitTypes::Special_Map_Revealer], "the original security control sets its authored switch and removes its temporary revealer");
			require(!st.players[7].victory_state && zeratul->owner == 2, "opening original installation doors cannot bypass Zeratul rescue");
		} else if (scenario == 5) {
			approach_location(zealot, 17);
			for (int tick = 0; tick != 400; ++tick) step();
			require(st.trigger_switches[3] && st.unit_counts[7][UnitTypes::Protoss_Dragoon] == 1 && st.unit_counts[7][UnitTypes::Protoss_Zealot] == 4 && !st.players[7].victory_state, "the original field trigger creates exactly one Dragoon and two Zealots without an invented teleport or victory");
		} else if (scenario == 6) {
			unit_t* marine = nullptr;
			for (unit_t* unit : ptr(st.player_units[1])) if (functions.unit_is(unit, UnitTypes::Terran_Marine) && functions.is_in_bounds(unit->sprite->position, st.locations.at(33).area)) marine = unit;
			require(marine, "original rescuable Terran squad supplies the native contact and ambush fixture");
			unit_id marine_id = functions.get_unit_id(marine);
			approach_location(zealot, 34);
			for (int tick = 0; tick != 800 && marine->owner != 7; ++tick) step();
			require(functions.get_unit(marine_id) == marine && marine->owner == 7, "normal proximity rescues the same original Marine without direct ownership changes");
			functions.set_unit_order(marine, functions.get_order_type(Orders::HoldPosition));
			int hydralisks_before = st.unit_counts[6][UnitTypes::Zerg_Hydralisk] + st.dead_unit_counts[6][UnitTypes::Zerg_Hydralisk];
			int infested_before = st.unit_counts[6][UnitTypes::Zerg_Infested_Terran] + st.dead_unit_counts[6][UnitTypes::Zerg_Infested_Terran];
			approach_location(marine, 11);
			for (int tick = 0; tick != 1000 && st.unit_counts[6][UnitTypes::Zerg_Hydralisk] + st.dead_unit_counts[6][UnitTypes::Zerg_Hydralisk] < hydralisks_before + 3; ++tick) step();
			require(st.unit_counts[6][UnitTypes::Zerg_Hydralisk] + st.dead_unit_counts[6][UnitTypes::Zerg_Hydralisk] == hydralisks_before + 3 && st.unit_counts[6][UnitTypes::Zerg_Infested_Terran] + st.dead_unit_counts[6][UnitTypes::Zerg_Infested_Terran] == infested_before + 1, "a rescued original Marine runs the first source dialogue and exact Hydralisk/Infested Terran ambush");
			int zerglings_before = st.unit_counts[6][UnitTypes::Zerg_Zergling] + st.dead_unit_counts[6][UnitTypes::Zerg_Zergling];
			infested_before = st.unit_counts[6][UnitTypes::Zerg_Infested_Terran] + st.dead_unit_counts[6][UnitTypes::Zerg_Infested_Terran];
			approach_location(marine, 40);
			for (int tick = 0; tick != 1000 && st.unit_counts[6][UnitTypes::Zerg_Zergling] + st.dead_unit_counts[6][UnitTypes::Zerg_Zergling] < zerglings_before + 8; ++tick) step();
			require(st.unit_counts[6][UnitTypes::Zerg_Zergling] + st.dead_unit_counts[6][UnitTypes::Zerg_Zergling] == zerglings_before + 8 && st.unit_counts[6][UnitTypes::Zerg_Infested_Terran] + st.dead_unit_counts[6][UnitTypes::Zerg_Infested_Terran] == infested_before + 1 && !st.players[7].victory_state, "the second original Marine contact creates its exact eight Zerglings and one Infested Terran without inventing victory");
		} else if (scenario == 7) {
			unit_id zeratul_id = functions.get_unit_id(zeratul);
			approach_location(zealot, 30);
			for (int tick = 0; tick != 400; ++tick) step();
			require(st.trigger_switches[5], "the original cell control runs before the isolated final rescue approach");
			xy destination = zeratul->sprite->position;
			bool approach_found = false;
			for (int offset_y = -192; offset_y <= 192 && !approach_found; offset_y += 16) for (int offset_x = -192; offset_x <= 192 && !approach_found; offset_x += 16) {
				xy candidate = destination + xy(offset_x, offset_y);
				if (functions.xy_length(candidate - destination) < 128 || !functions.unit_type_can_fit_at(zealot->unit_type, candidate) || !functions.is_reachable(zeratul, candidate)) continue;
				functions.move_unit(zealot, candidate);
				auto placement = functions.find_unit_placement(zealot, candidate, false);
				if (!placement.first || functions.xy_length(placement.second - destination) < 128 || !functions.is_reachable(zeratul, placement.second)) continue;
				functions.move_unit(zealot, placement.second);
				approach_found = true;
			}
			require(approach_found, "native terrain and ground reachability supply a legal isolated cell approach outside rescue range");
			functions.issue_order(zealot, false, functions.get_order_type(Orders::Move), {destination, nullptr});
			bool ending_paused = false;
			for (int tick = 0; tick != 6000 && !st.players[7].victory_state; ++tick) { step(); ending_paused = ending_paused || st.scripted_pause; }
			zeratul = functions.get_unit(zeratul_id);
			require(zeratul && zeratul->owner == 7 && ending_paused && st.players[7].victory_state >= 3 && st.unit_counts[7][UnitTypes::Hero_Tassadar] == 1 && st.non_building_counts[3] + st.non_building_counts[6] > 0, "native contact rescues the same original Zeratul and runs all original ending dialogue and victory with enemies remaining");
		} else {
			require(!st.campaign_ai[3].town_active && !st.campaign_ai[3].suicide && st.campaign_ai[3].attacking.empty(), "original placed Zerg troops begin without a town or an invented suicide assault");
			approach_location(zealot, 29);
			for (int tick = 0; tick != 800 && st.campaign_ai[3].attacking.empty(); ++tick) step();
			require(!st.campaign_ai[3].town_active && !st.campaign_ai[3].attacking.empty() && !st.campaign_ai[7].town_active && !st.players[7].victory_state, "the original contact-triggered Suic orders placed Zerg troops into a native assault without inventing a town or victory");
			require(st.campaign_ai_scripts.empty() && !st.campaign_ai[3].suicide, "the original two-instruction Suic program stops after dispatching its placed troops");
			unit_t* distant = nullptr;
			for (unit_id id : st.campaign_ai[3].attacking) {
				unit_t* unit = functions.get_unit(id);
				if (!unit || functions.unit_dying(unit)) continue;
				bool near_human = false;
				for (unit_t* target : ptr(st.player_units[7])) if (!functions.unit_dying(target) && functions.units_distance(unit, target) < 512) near_human = true;
				if (!near_human) { distant = unit; break; }
			}
			require(distant, "an original distant assault member supplies the post-script retargeting check");
			functions.set_unit_order(distant, functions.get_order_type(Orders::PlayerGuard));
			distant->auto_target_unit = nullptr;
			for (int tick = 0; tick != 16; ++tick) step();
			require(distant->order_type->id == Orders::AttackMove && !st.campaign_ai[3].town_active && st.campaign_ai_scripts.empty(), "standalone attackers retain native strategic orders after Suic has stopped without running town economy");
			unit_id removed_id = functions.get_unit_id(distant);
			functions.kill_unit(distant);
			for (int tick = 0; tick != 16; ++tick) step();
			require(std::find(st.campaign_ai[3].attacking.begin(), st.campaign_ai[3].attacking.end(), removed_id) == st.campaign_ai[3].attacking.end() && !st.current_minerals[3] && !st.current_gas[3], "standalone assault cleanup removes dead native handles without granting resources");
		}
		printf("Into the Darkness original mission case %d passed.\n", scenario);
	}
}

static void homeland_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 8; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (int owner : {2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				if (functions.ut_building(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 1200; ++tick) step();
		unit_t* heroes[3]{};
		UnitTypes hero_types[] = {UnitTypes::Hero_Fenix_Dragoon, UnitTypes::Hero_Tassadar, UnitTypes::Hero_Zeratul};
		for (int owner : {2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) for (int index = 0; index != 3; ++index) if (functions.unit_is(unit, hero_types[index])) heroes[index] = unit;
		unit_t* escort = nullptr;
		for (unit_t* unit : ptr(st.player_units[7])) if (functions.unit_is(unit, UnitTypes::Protoss_Zealot)) escort = unit;
		require(heroes[0] && heroes[1] && heroes[2] && escort && !st.scripted_pause && !st.trigger_switches[0], "Homeland finishes its original introduction with all three original heroes and both enemy Nexus forces intact");
		if (scenario < 4) {
			if (scenario == 0) {
				a_vector<unit_t*> victims;
				for (unit_t* unit : ptr(st.player_units[7])) if (!functions.unit_dying(unit)) victims.push_back(unit);
				for (unit_t* unit : victims) functions.kill_unit(unit);
			} else functions.kill_unit(heroes[scenario - 1]);
			for (int tick = 0; tick != 1000 && !st.players[7].victory_state; ++tick) step();
			require(st.players[7].victory_state == 2, "original human-force or any required Fenix/Tassadar/Zeratul loss reaches Homeland defeat");
		} else {
			for (unit_t* hero : heroes) {
				unit_id original_id = functions.get_unit_id(hero);
				if (hero->owner != 7) {
					functions.issue_order(escort, false, functions.get_order_type(Orders::Move), {hero->sprite->position, nullptr});
					for (int tick = 0; tick != 3000 && hero->owner != 7; ++tick) step();
				}
				require(functions.get_unit(original_id) == hero && hero->owner == 7, "normal original-army movement naturally rescues the same Homeland hero without an ownership grant");
				functions.set_unit_order(hero, functions.get_order_type(Orders::HoldPosition));
			}
			if (scenario == 7) {
				a_vector<unit_id> originals;
				for (unit_t* unit : ptr(st.player_units[1])) if (functions.unit_is(unit, UnitTypes::Hero_Dark_Templar)) originals.push_back(functions.get_unit_id(unit));
				for (unit_id id : originals) {
					unit_t* templar = functions.get_unit(id);
					functions.issue_order(escort, false, functions.get_order_type(Orders::Move), {templar->sprite->position, nullptr});
					for (int tick = 0; tick != 1000 && templar->owner != 7; ++tick) step();
					require(functions.get_unit(id) == templar && templar->owner == 7 && functions.u_cloaked(templar), "native rescue retains each original classic Dark Templar and its permanent cloak");
				}
				for (int tick = 0; tick != 96; ++tick) step();
				require(st.unit_counts[7][UnitTypes::Hero_Dark_Templar] == 4 && !st.unit_counts[1][UnitTypes::Hero_Dark_Templar] && !st.players[7].victory_state && !st.trigger_switches[0], "all original hero and Dark Templar rescues preserve their identities without bypassing the Conclave objective");
			} else {
				int owner = scenario == 4 ? 4 : 0;
				a_vector<unit_t*> victims;
				for (unit_t* unit : ptr(st.player_units[owner])) if (functions.unit_is(unit, UnitTypes::Protoss_Nexus) && !functions.unit_dying(unit)) victims.push_back(unit);
				require(victims.size() == size_t(owner == 4 ? 1 : 2), "original enemy Nexus counts supply both source ending gates");
				int carriers_before = st.unit_counts[0][UnitTypes::Protoss_Carrier], shuttles_before = st.unit_counts[0][UnitTypes::Protoss_Shuttle];
				if (scenario == 6) victims.resize(1);
				for (unit_t* unit : victims) functions.kill_unit(unit);
				bool ending_paused = false;
				for (int tick = 0; tick != 5000 && !st.players[7].victory_state; ++tick) { step(); ending_paused = ending_paused || st.scripted_pause; }
				if (scenario == 6) require(!ending_paused && !st.trigger_switches[0] && !st.players[7].victory_state && st.unit_counts[0][UnitTypes::Protoss_Nexus] > 0 && st.unit_counts[4][UnitTypes::Protoss_Nexus] > 0, "one destroyed Nexus cannot end Homeland while both enemy forces still own a Nexus");
				else {
					require(ending_paused && st.trigger_switches[0] && st.players[7].victory_state >= 3 && st.unit_counts[owner == 4 ? 0 : 4][UnitTypes::Protoss_Nexus] > 0 && st.building_counts[0] + st.building_counts[4] > 0, "either original enemy force losing all its Nexuses runs the original surrender ending and victory without requiring all buildings or both forces to be destroyed");
					require(st.unit_counts[0][UnitTypes::Protoss_Carrier] >= carriers_before + 2 && st.unit_counts[0][UnitTypes::Protoss_Shuttle] >= shuttles_before + 1, "the original ending creates its two Carriers and Shuttle for the Conclave");
					const auto& camera = st.locations.at(2).area;
					require((camera.from + camera.to) / 2 == heroes[1]->sprite->position, "the original ending moves its location onto the naturally rescued Tassadar");
				}
			}
		}
		printf("Homeland original mission case %d passed.\n", scenario);
	}
}

static void trial_tassadar_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 5; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (int owner : {2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		unit_t* raynor = nullptr;
		unit_t* fenix = nullptr;
		unit_t* carrier = nullptr;
		unit_t* escort = nullptr;
		unit_t* prison = nullptr;
		for (int owner : {2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) {
			if (functions.unit_is(unit, UnitTypes::Hero_Hyperion)) raynor = unit;
			if (functions.unit_is(unit, UnitTypes::Hero_Fenix_Dragoon)) fenix = unit;
		}
		for (unit_t* unit : ptr(st.player_units[7])) {
			if (functions.unit_is(unit, UnitTypes::Protoss_Carrier)) carrier = unit;
			if (functions.unit_is(unit, UnitTypes::Protoss_Zealot)) escort = unit;
		}
		for (unit_t* unit : ptr(st.player_units[0])) if (functions.unit_is(unit, UnitTypes::Special_Stasis_Cell_Prison)) prison = unit;
		require(raynor && fenix && carrier && escort && prison && st.trigger_switches[13] && !functions.unit_interceptor_count(carrier), "original Raynor and source-created Fenix survive setup with an empty Carrier and original Stasis Cell");
		auto cinematic_controller = st.players[1].controller;
		if (scenario < 3) {
			if (scenario == 0) {
				a_vector<unit_t*> victims;
				for (unit_t* unit : ptr(st.player_units[7])) if (!functions.unit_dying(unit)) victims.push_back(unit);
				for (unit_t* unit : victims) functions.kill_unit(unit);
			} else functions.kill_unit(scenario == 1 ? raynor : fenix);
			for (int tick = 0; tick != 1000 && !st.players[7].victory_state; ++tick) step();
			require(st.players[7].victory_state == 2, "original human-force, Raynor or source-guarded Fenix loss reaches Trial of Tassadar defeat");
		} else {
			for (unit_t* hero : {raynor, fenix}) {
				unit_id original_id = functions.get_unit_id(hero);
				if (hero->owner != 7) {
					functions.issue_order(escort, false, functions.get_order_type(Orders::Move), {hero->sprite->position, nullptr});
					for (int tick = 0; tick != 1600 && hero->owner != 7; ++tick) step();
				}
				require(functions.get_unit(original_id) == hero && hero->owner == 7, "normal original-army proximity naturally rescues the same Raynor and Fenix without grants");
				functions.set_unit_order(hero, functions.get_order_type(Orders::HoldPosition));
			}
			if (scenario == 3) {
				a_vector<unit_t*> victims;
				for (int owner : {0, 3}) for (unit_t* unit : ptr(st.player_units[owner])) if (functions.unit_is(unit, UnitTypes::Protoss_Nexus) && !functions.unit_dying(unit)) victims.push_back(unit);
				for (unit_t* unit : victims) functions.kill_unit(unit);
				for (int tick = 0; tick != 160; ++tick) step();
				require(!st.players[7].victory_state && st.unit_counts[0][UnitTypes::Special_Stasis_Cell_Prison] == 1, "destroying all Conclave Nexuses cannot replace the original Stasis Cell objective");
				functions.move_unit(carrier, prison->sprite->position + xy(192, -160));
				for (int tick = 0; tick != 64; ++tick) step();
				fp8 initial_hp = prison->hp, initial_shields = prison->shield_points;
				functions.issue_order(carrier, false, carrier->unit_type->attack_unit, {prison->sprite->position, prison});
				for (int tick = 0; tick != 160; ++tick) step();
				require(!functions.unit_interceptor_count(carrier) && prison->hp >= initial_hp && prison->shield_points >= initial_shields && !st.players[7].victory_state, "the original empty Carrier cannot damage the Stasis Cell without real Interceptors");
				action_state player_commands;
				action_functions actions(st, player_commands);
				require(actions.action_select(7, carrier) && actions.action_train_fighter(7), "the original Carrier accepts normal paid Interceptor production");
				for (int tick = 0; tick != 600 && !functions.unit_interceptor_count(carrier); ++tick) step();
				require(functions.unit_interceptor_count(carrier) == 1 && st.current_minerals[7] == 45 && !st.current_gas[7], "native Interceptor production charges twenty-five of the original seventy minerals without funding or ammunition grants");
				functions.set_unit_shield_points(prison, 0_fp8);
				functions.set_unit_hp(prison, fp8::integer(1));
				functions.issue_order(carrier, false, carrier->unit_type->attack_unit, {prison->sprite->position, prison});
				bool launched = false;
				for (int tick = 0; tick != 2400 && !st.killed_unit_counts[7][UnitTypes::Special_Stasis_Cell_Prison]; ++tick) { step(); launched = launched || carrier->carrier.outside_count > 0; }
				require(launched && st.killed_unit_counts[7][UnitTypes::Special_Stasis_Cell_Prison] == 1, "a paid native Interceptor launches and supplies an actual player weapon kill of the original Stasis Cell");
			} else functions.kill_unit(prison);
			bool ending_paused = false;
			for (int tick = 0; tick != 6000 && !st.players[7].victory_state; ++tick) { step(); ending_paused = ending_paused || st.scripted_pause; }
			require(ending_paused && st.players[7].victory_state >= 3 && st.building_counts[0] + st.building_counts[3] > 0, "Stasis Cell destruction runs the original paused rescue ending and victory with other enemy buildings remaining");
			require(st.unit_counts[2][UnitTypes::Hero_Tassadar] + st.unit_counts[7][UnitTypes::Hero_Tassadar] == 1 && st.unit_counts[2][UnitTypes::Hero_Zeratul] + st.unit_counts[7][UnitTypes::Hero_Zeratul] == 1 && st.unit_counts[1][UnitTypes::Hero_Dark_Templar] == 9, "the source ending creates its single Tassadar, single Zeratul and nine classic Dark Templars without dropping inactive-owner cinematic actors");
			bool cinematic_slot_active = false;
			for (int owner : functions.trigger_players(7, 17)) if (owner == 1) cinematic_slot_active = true;
			require(st.players[1].controller == cinematic_controller && !cinematic_slot_active && !st.campaign_ai[1].town_active, "explicit cinematic creation does not activate the unused slot, its group-trigger membership or economy AI");
		}
		printf("The Trial of Tassadar original mission case %d passed.\n", scenario);
	}
}

static void shadow_hunters_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 6; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (int owner : {2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		unit_t* zeratul = nullptr;
		unit_t* fenix = nullptr;
		unit_t* escort = nullptr;
		for (int owner : {2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) {
			if (functions.unit_is(unit, UnitTypes::Hero_Zeratul)) zeratul = unit;
			if (functions.unit_is(unit, UnitTypes::Hero_Fenix_Dragoon)) fenix = unit;
		}
		for (unit_t* unit : ptr(st.player_units[7])) if (functions.unit_is(unit, UnitTypes::Protoss_Zealot)) escort = unit;
		require(zeratul && fenix && escort && !st.trigger_switches[0] && !st.trigger_switches[1], "original Shadow Hunters heroes and both Cerebrate completion gates remain intact");
		if (scenario < 3) {
			if (scenario == 0) {
				a_vector<unit_t*> victims;
				for (unit_t* unit : ptr(st.player_units[7])) if (!functions.unit_dying(unit)) victims.push_back(unit);
				for (unit_t* unit : victims) functions.kill_unit(unit);
			} else functions.kill_unit(scenario == 1 ? fenix : zeratul);
			for (int tick = 0; tick != 1000 && !st.players[7].victory_state; ++tick) step();
			require(st.players[7].victory_state == 2, "original human-force, Fenix or Zeratul loss reaches Shadow Hunters defeat");
		} else {
			for (unit_t* hero : {zeratul, fenix}) {
				unit_id original_id = functions.get_unit_id(hero);
				if (hero->owner != 7) {
					functions.issue_order(escort, false, functions.get_order_type(Orders::Move), {hero->sprite->position, nullptr});
					for (int tick = 0; tick != 1200 && hero->owner != 7; ++tick) step();
				}
				require(functions.get_unit(original_id) == hero && hero->owner == 7, "native proximity rescues the same original Shadow Hunters heroes without ownership grants");
				functions.set_unit_order(hero, functions.get_order_type(Orders::HoldPosition));
			}
			if (scenario == 3) {
				for (int owner : {6, 5}) for (int attempt = 0; attempt != 2; ++attempt) {
					unit_t* cerebrate = nullptr;
					for (unit_t* unit : ptr(st.player_units[owner])) if (functions.unit_is(unit, UnitTypes::Special_Cerebrate) && !functions.unit_dying(unit)) cerebrate = unit;
					require(cerebrate, "the original or source-restored Cerebrate supplies the repeatable wrong-kill fixture");
					unit_id previous_id = functions.get_unit_id(cerebrate);
					functions.kill_unit(cerebrate);
					for (int tick = 0; tick != 160; ++tick) step();
					unit_t* restored = nullptr;
					for (unit_t* unit : ptr(st.player_units[owner])) if (functions.unit_is(unit, UnitTypes::Special_Cerebrate) && !functions.unit_dying(unit)) restored = unit;
					require(restored && functions.get_unit_id(restored).raw_value != previous_id.raw_value && st.unit_counts[owner][UnitTypes::Special_Cerebrate] == 1 && !st.trigger_switches[owner == 6 ? 0 : 1] && !st.players[7].victory_state, "a Cerebrate destroyed without Zeratul is recreated by its original preserved trigger without completion or victory");
				}
			} else {
				for (int stage = 0; stage != 2; ++stage) {
					int owner = (scenario == 4 ? stage == 0 : stage != 0) ? 6 : 5;
					int location = owner == 6 ? 1 : 2;
					unit_t* cerebrate = nullptr;
					for (unit_t* unit : ptr(st.player_units[owner])) if (functions.unit_is(unit, UnitTypes::Special_Cerebrate) && !functions.unit_dying(unit)) cerebrate = unit;
					require(cerebrate, "each original Cerebrate remains for its independent Zeratul completion gate");
					const auto& region = st.locations.at(location - 1).area;
					bool approach_found = false;
					for (int map_y = region.from.y + 8; map_y < region.to.y && !approach_found; map_y += 8) for (int map_x = region.from.x + 8; map_x < region.to.x && !approach_found; map_x += 8) {
						xy candidate(map_x, map_y);
						if (!functions.unit_type_can_fit_at(zeratul->unit_type, candidate) || !functions.is_reachable(cerebrate, candidate)) continue;
						functions.move_unit(zeratul, candidate);
						auto placement = functions.find_unit_placement(zeratul, candidate, false);
						if (!placement.first || !functions.is_in_bounds(placement.second, region)) continue;
						functions.move_unit(zeratul, placement.second);
						approach_found = true;
					}
					require(approach_found, "native terrain supplies a legal isolated Zeratul combat approach in the original Cerebrate region");
					functions.set_unit_hp(cerebrate, fp8::integer(1));
					functions.issue_order(zeratul, false, zeratul->unit_type->attack_unit, {cerebrate->sprite->position, cerebrate});
					int previous_kills = st.killed_unit_counts[7][UnitTypes::Special_Cerebrate];
					for (int tick = 0; tick != 1600 && !st.trigger_switches[owner == 6 ? 0 : 1]; ++tick) step();
					require(st.killed_unit_counts[7][UnitTypes::Special_Cerebrate] == previous_kills + 1 && st.trigger_switches[owner == 6 ? 0 : 1] && !st.unit_counts[owner][UnitTypes::Special_Cerebrate] && functions.u_cloaked(zeratul), "the same original cloaked Zeratul kills the Cerebrate with a native weapon inside its authored ground region");
					functions.set_unit_order(zeratul, functions.get_order_type(Orders::HoldPosition));
					if (stage == 0) {
						for (int tick = 0; tick != 96; ++tick) step();
						require(!st.players[7].victory_state && st.unit_counts[owner == 6 ? 5 : 6][UnitTypes::Special_Cerebrate] == 1, "one completed original Cerebrate gate cannot bypass the other");
					}
				}
				for (int tick = 0; tick != 160 && !st.players[7].victory_state; ++tick) step();
				require(st.players[7].victory_state >= 3 && st.trigger_switches[0] && st.trigger_switches[1] && st.building_counts[0] + st.building_counts[5] + st.building_counts[6] > 0, "either original Zeratul kill order completes both source switches and victory with other Zerg buildings remaining");
			}
		}
		printf("Shadow Hunters original mission case %d passed.\n", scenario);
	}
}

static void eye_storm_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 5; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		for (unit_t* unit : ptr(st.player_units[1])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (int owner : {1, 2}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
				functions.set_unit_hp(unit, unit->unit_type->hitpoints);
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 1200; ++tick) step();
		unit_t* heroes[3]{};
		UnitTypes hero_types[] = {UnitTypes::Hero_Zeratul, UnitTypes::Hero_Gantrithor, UnitTypes::Hero_Hyperion};
		for (int owner : {1, 2}) for (unit_t* unit : ptr(st.player_units[owner])) for (int index = 0; index != 3; ++index) if (functions.unit_is(unit, hero_types[index])) heroes[index] = unit;
		unit_t* overmind = nullptr;
		for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Special_Overmind_With_Shell)) overmind = unit;
		require(heroes[0] && heroes[1] && heroes[2] && overmind && !st.players[1].victory_state, "Eye of the Storm retains its original three heroes and living Overmind after source setup");
		if (scenario < 3) {
			functions.kill_unit(heroes[scenario]);
			for (int tick = 0; tick != 1000 && !st.players[1].victory_state; ++tick) step();
			require(st.players[1].victory_state == 2, "each original Zeratul, Tassadar/Gantrithor or Raynor loss reaches the authored final-mission defeat");
		} else {
			for (unit_t* hero : heroes) {
				unit_id original_id = functions.get_unit_id(hero);
				if (hero->owner != 1) {
					unit_t* escort = functions.find_nearest_unit(hero->sprite->position, functions.map_bounds(), [&](const unit_t* unit) { return unit->owner == 1 && !functions.unit_dying(unit) && !functions.ut_building(unit) && !functions.us_hidden(unit) && functions.u_can_move(unit); });
					require(escort, "an original local human actor can approach the source hero");
					functions.issue_order(escort, false, functions.get_order_type(Orders::Move), {hero->sprite->position, nullptr});
					for (int tick = 0; tick != 1600 && hero->owner != 1; ++tick) step();
				}
				require(functions.get_unit(original_id) == hero && hero->owner == 1, "normal local proximity rescues the same original hero without grants or race conversion");
				functions.set_unit_order(hero, functions.get_order_type(Orders::HoldPosition));
			}
			if (scenario == 3) {
				a_vector<unit_t*> victims;
				for (int owner : {0, 3}) for (unit_t* unit : ptr(st.player_units[owner])) if (unit != overmind && functions.ut_building(unit) && !functions.unit_dying(unit)) victims.push_back(unit);
				for (unit_t* unit : victims) functions.kill_unit(unit);
				for (int tick = 0; tick != 800; ++tick) step();
				require(st.unit_counts[3][UnitTypes::Special_Overmind_With_Shell] == 1 && !st.players[1].victory_state && !st.scripted_pause, "clearing other original Zerg structures cannot bypass the living Overmind objective");
			} else {
				unit_t* gantrithor = heroes[1];
				require(!functions.unit_interceptor_count(gantrithor), "the original Gantrithor does not receive test ammunition grants");
				action_state player_commands;
				action_functions actions(st, player_commands);
				require(actions.action_select(1, gantrithor) && actions.action_train_fighter(1), "original Gantrithor accepts normal paid native Interceptor production under the slot-1 human owner");
				for (int tick = 0; tick != 600 && !functions.unit_interceptor_count(gantrithor); ++tick) step();
				require(functions.unit_interceptor_count(gantrithor) == 1 && st.current_minerals[1] == 75 && st.current_gas[1] == 100, "Gantrithor's native Interceptor costs twenty-five of the original hundred minerals");
				functions.move_unit(gantrithor, overmind->sprite->position + xy(192, -160));
				for (int tick = 0; tick != 64; ++tick) step();
				functions.set_unit_shield_points(overmind, 0_fp8);
				functions.set_unit_hp(overmind, fp8::integer(1));
				functions.issue_order(gantrithor, false, gantrithor->unit_type->attack_unit, {overmind->sprite->position, overmind});
				bool launched = false;
				for (int tick = 0; tick != 2400 && !st.killed_unit_counts[1][UnitTypes::Special_Overmind_With_Shell]; ++tick) { step(); launched = launched || gantrithor->carrier.outside_count > 0; }
				require(launched && st.killed_unit_counts[1][UnitTypes::Special_Overmind_With_Shell] == 1, "a paid native Gantrithor Interceptor launches and supplies a real player weapon kill of the original Overmind");
				bool ending_paused = false;
				for (int tick = 0; tick != 2400 && !st.players[1].victory_state; ++tick) { step(); ending_paused = ending_paused || st.scripted_pause; }
				require(ending_paused && st.players[1].victory_state >= 3 && st.building_counts[0] + st.building_counts[3] > 0, "Overmind destruction runs the original paused Tassadar ending and victory with other enemy buildings remaining");
				const auto& camera = st.locations.at(1).area;
				require((camera.from + camera.to) / 2 == gantrithor->sprite->position, "the original ending moves its location onto the same rescued Gantrithor");
			}
		}
		printf("Eye of the Storm original mission case %d passed.\n", scenario);
	}
}

static void legacy_xelnaga_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 6; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		require(st.game->scenario_format == 205 && st.players[1].race == race_t::protoss && st.unit_counts[1][UnitTypes::Protoss_Probe] == 5 && st.unit_counts[1][UnitTypes::Protoss_Dark_Templar] == 2 && st.unit_counts[1][UnitTypes::Protoss_Nexus] == 1 && st.unit_counts[1][UnitTypes::Protoss_Gateway] == 1 && st.unit_counts[1][UnitTypes::Protoss_Templar_Archives] == 1 && st.unit_counts[1][UnitTypes::Protoss_Pylon] == 3, "Legacy retains the original expansion Dark Templars, five Probes and authored base");
		a_vector<unit_t*> templars;
		for (unit_t* unit : ptr(st.player_units[1])) {
			functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			if (functions.unit_is(unit, UnitTypes::Protoss_Dark_Templar)) templars.push_back(unit);
		}
		auto step = [&]() {
			for (int owner : {1, 2, 5, 7}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 400; ++tick) step();
		require(st.current_minerals[1] == 250 && st.current_gas[1] == 75 && !st.players[1].victory_state && st.campaign_ai[3].town_active && st.campaign_ai[4].town_active, "original 250/75 funding and both expansion Zerg main programs survive the opening transmission");
		if (scenario == 0) {
			int peak_corsairs = 0, peak_shuttles = 0, peak_webs = 0;
			bool webbed = false;
			for (int tick = 0; tick != 2400; ++tick) {
				step();
				peak_corsairs = std::max(peak_corsairs, st.unit_counts[2][UnitTypes::Protoss_Corsair]);
				peak_shuttles = std::max(peak_shuttles, st.unit_counts[2][UnitTypes::Protoss_Shuttle]);
				peak_webs = std::max(peak_webs, st.unit_counts[11][UnitTypes::Spell_Disruption_Web]);
				webbed = webbed || st.disruption_webbed_units > 0;
			}
			bool still_inhibited = false;
			for (unit_t* unit : ptr(st.visible_units)) if (!functions.unit_dying(unit) && functions.u_cannot_attack(unit)) still_inhibited = true;
			require(st.trigger_switches[7] && peak_corsairs == 4 && peak_shuttles == 2 && peak_webs == 4 && webbed && !st.unit_counts[11][UnitTypes::Spell_Disruption_Web] && !still_inhibited && !st.players[1].victory_state, "the original demonstration creates four Corsairs, two Shuttles and four native Webs that inhibit ground fire and expire normally");
		} else if (scenario == 1) {
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[1])) if (!functions.unit_dying(unit)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
			for (int tick = 0; tick != 128 && !st.players[1].victory_state; ++tick) step();
			require(st.players[1].victory_state == 2, "loss of the original human buildings reaches the native Legacy defeat");
		} else if (scenario <= 4) {
			unit_t* first = nullptr;
			unit_t* second = nullptr;
			for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is(unit, UnitTypes::Special_Cerebrate)) first = unit;
			for (unit_t* unit : ptr(st.player_units[4])) if (functions.unit_is(unit, UnitTypes::Special_Cerebrate)) second = unit;
			require(first && second, "both original Cerebrates retain their distinct owners");
			if (scenario == 2) {
				functions.kill_unit(first);
				for (int tick = 0; tick != 128; ++tick) step();
				require(st.unit_counts[3][UnitTypes::Special_Cerebrate] == 1 && !st.trigger_switches[0] && !st.trigger_switches[9] && !st.players[1].victory_state, "destroying a Cerebrate without a nearby expansion Dark Templar lets the original trigger recreate it");
			} else {
				for (int index = 0; index != (scenario == 4 ? 2 : 1); ++index) {
					unit_t* target = index ? second : first;
					unit_t* templar = templars[index];
					functions.move_unit(templar, target->sprite->position + xy(64, 0));
					functions.refresh_unit_position(templar);
					functions.set_unit_hp(target, fp8::integer(1));
					target->shield_points = fp8::integer(0);
					functions.issue_order(templar, false, templar->unit_type->attack_unit, {target->sprite->position, target});
					for (int tick = 0; tick != 1000 && !st.trigger_switches[index]; ++tick) step();
					require(st.trigger_switches[index] && !st.unit_counts[index ? 4 : 3][UnitTypes::Special_Cerebrate], "an original expansion Dark Templar uses native weapon damage to satisfy its Cerebrate region gate");
				}
				if (scenario == 3) {
					for (int tick = 0; tick != 600; ++tick) step();
					require(!st.trigger_switches[1] && !st.trigger_switches[9] && !st.players[1].victory_state, "the second live Cerebrate blocks the ending after the first valid Dark Templar kill");
				} else {
					bool kerrigan = false, zeratul = false, aldaris = false, paused = false;
					for (int tick = 0; tick != 7000 && !st.players[1].victory_state; ++tick) {
						step();
						kerrigan = kerrigan || st.unit_counts[3][UnitTypes::Hero_Infested_Kerrigan] > 0;
						zeratul = zeratul || st.unit_counts[2][UnitTypes::Hero_Zeratul] > 0;
						aldaris = aldaris || st.unit_counts[7][UnitTypes::Hero_Tassadar] > 0;
						paused = paused || st.scripted_pause;
					}
					require(st.trigger_switches[9] && st.trigger_switches[50] && kerrigan && zeratul && aldaris && paused && st.players[1].victory_state >= 3, "both original Cerebrate gates run ownership handoff, the Kerrigan arrival, original heroes and the full paused ending to victory");
				}
			}
		} else {
			bool fired[2] = {};
			bool reachable_target = false;
			for (int tick = 0; tick != 18000 && !(fired[0] && fired[1]); ++tick) {
				step();
				if (!reachable_target && st.campaign_ai[4].attack_party.size() >= 6) {
					unit_t* attacker = functions.get_unit(st.campaign_ai[4].attack_party.front());
					for (unit_t* unit : ptr(st.player_units[1])) if (functions.unit_is(unit, UnitTypes::Protoss_Probe)) {
						functions.move_unit(unit, attacker->sprite->position + xy(64, 0));
						functions.refresh_unit_position(unit);
						require(functions.is_reachable(attacker, unit), "the isolated eastern attack-party fixture places an original protected Probe on reachable terrain");
						reachable_target = true;
						break;
					}
				}
				for (unit_id id : st.campaign_ai[3].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (unit && !functions.unit_dying(unit) && (unit->ground_weapon_cooldown || unit->air_weapon_cooldown)) fired[0] = true;
				}
				if (reachable_target) for (unit_t* unit : ptr(st.player_units[4])) if (!functions.unit_dying(unit) && (functions.unit_is(unit, UnitTypes::Zerg_Zergling) || functions.unit_is(unit, UnitTypes::Zerg_Hydralisk)) && unit->ground_weapon_cooldown) fired[1] = true;
			}
			require(reachable_target && fired[0] && fired[1], "PB3A attacks the original base and PB3C assembles its original-timed party and fires native weapons at a reachable protected original Probe");
		}
		printf("Legacy of the Xel'Naga original mission case %d passed.\n", scenario);
	}
}

static void battle_of_braxis_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 2; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		require(st.game->scenario_format == 205 && st.players[1].controller == player_t::controller_occupied && st.players[1].race == race_t::protoss && !st.building_counts[1] && st.unit_counts[1][UnitTypes::Protoss_Observer] == 3 && st.unit_counts[1][UnitTypes::Protoss_Shuttle] == 2 && st.unit_counts[1][UnitTypes::Protoss_Scout] == 3 && st.unit_counts[1][UnitTypes::Protoss_Zealot] == 4 && st.unit_counts[1][UnitTypes::Protoss_Dragoon] == 2, "The Battle of Braxis retains its original slot-1 baseless Protoss force");
		require(st.unit_counts[1][UnitTypes::Hero_Artanis] == 1 && st.unit_counts[7][UnitTypes::Special_Power_Generator] == 5 && !st.current_minerals[1] && !st.current_gas[1] && !st.countdown_active, "The original Artanis is naturally rescued, and the five generators, zero setup resources and untimed start are retained");
		auto step = [&]() {
			for (int owner : {1, 2}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		const auto& artanis_loss_gate = st.game->triggers[2].conditions[0];
		require(artanis_loss_gate.unit_id == int(UnitTypes::Hero_Artanis) && !functions.test_trigger_condition(artanis_loss_gate, 1), "the authored Artanis loss predicate remains false while the naturally rescued hero survives");
		require(!st.players[1].victory_state, "The original idle opening does not award an early outcome");
		if (scenario == 0) {
			a_vector<unit_t*> generators;
			for (unit_t* unit : ptr(st.player_units[7])) if (functions.unit_is(unit, UnitTypes::Special_Power_Generator) && !functions.unit_dying(unit)) generators.push_back(unit);
			require(generators.size() == 5, "the original UED owner supplies all five power generators");
			for (int index = 0; index != 4; ++index) functions.kill_unit(generators[index]);
			for (int tick = 0; tick != 512; ++tick) step();
			require(!st.players[1].victory_state && !(st.trigger_switches[1] && st.trigger_switches[2] && st.trigger_switches[3] && st.trigger_switches[4] && st.trigger_switches[5]), "one surviving original generator blocks the source victory");
			functions.kill_unit(generators[4]);
			for (int tick = 0; tick != 5000 && !st.players[1].victory_state; ++tick) step();
			require(st.trigger_switches[1] && st.trigger_switches[2] && st.trigger_switches[3] && st.trigger_switches[4] && st.trigger_switches[5] && st.players[1].victory_state >= 3, "destroying all five original generators satisfies the source victory and ending");
		} else {
			unit_t* artanis = nullptr;
			for (unit_t* unit : ptr(st.player_units[1])) if (functions.unit_is(unit, UnitTypes::Hero_Artanis) && !functions.unit_dying(unit)) artanis = unit;
			require(artanis, "the original rescued Artanis remains available for its loss predicate");
			functions.kill_unit(artanis);
			for (int tick = 0; tick != 1000 && !st.players[1].victory_state; ++tick) step();
			require(st.players[1].victory_state == 2, "losing the original Artanis reaches the authored defeat");
		}
		printf("The Battle of Braxis original mission case %d passed.\n", scenario);
	}
}

static void quest_for_uraj_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 4; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.setup_info.create_melee_units_for_player[1] = true;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		require(st.game->scenario_format == 205 && st.players[1].controller == player_t::controller_occupied && st.players[1].race == race_t::protoss && st.unit_counts[1][UnitTypes::Protoss_Probe] == 4 && st.unit_counts[1][UnitTypes::Protoss_Nexus] == 1 && st.unit_counts[2][UnitTypes::Protoss_Shuttle] == 3 && st.unit_counts[6][UnitTypes::Powerup_Uraj_Crystal] == 1, "Quest for Uraj retains the authored Protoss start, three rescuable Shuttles and Uraj crystal");
		require(st.game->unit_type_allowed[1][UnitTypes::Protoss_Probe] && st.game->unit_type_allowed[1][UnitTypes::Protoss_Nexus] && !st.current_minerals[1] && !st.current_gas[1] && !st.countdown_active, "Quest for Uraj keeps native unit availability, zero resources and no invented countdown");
		auto step = [&]() {
			for (int owner : {1, 2, 3}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		require(st.trigger_switches[12] && st.trigger_switches[99] && st.campaign_ai[0].town_active && st.campaign_ai[0].area_towns.size() == 2 && st.campaign_ai[0].build_requests[UnitTypes::Terran_SCV].first == 4 && st.campaign_ai[5].area_towns.size() == 1 && st.players[5].controller == player_t::controller_computer_game && !st.alliances[5][1], "the original start activates Terran town/build requests and the enemy-owned AI relation");
		require(!st.players[1].victory_state, "The original idle opening does not award an early outcome");
		if (scenario == 0) {
			unit_t* shuttle = nullptr;
			for (unit_t* unit : ptr(st.player_units[2])) if (functions.unit_is(unit, UnitTypes::Protoss_Shuttle) && !functions.unit_dying(unit)) { shuttle = unit; break; }
			require(shuttle, "the original player-2 Shuttle is available for the Drop02 check");
			const auto& drop02 = st.locations.at(1).area;
			functions.move_unit(shuttle, drop02.from + xy(8, 8));
			functions.refresh_unit_position(shuttle);
			functions.set_unit_order(shuttle, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 3000 && !st.trigger_switches[2]; ++tick) step();
			unit_t* reaver = nullptr;
			for (unit_t* unit : ptr(st.player_units[1])) if (functions.unit_is(unit, UnitTypes::Protoss_Reaver) && !functions.unit_dying(unit)) reaver = unit;
			require(st.trigger_switches[2] && reaver && functions.unit_scarab_count(reaver) == 10, "the original Drop02 property creates one Reaver with ten real Scarabs");
			bool reachable_target = false;
			bool fired = false;
			int combat_budget = 18000;
			for (int tick = 0; tick != combat_budget && !fired; ++tick) {
				step();
				if (!reachable_target && st.campaign_ai[0].attack_party.size() >= 5) {
					unit_t* attacker = nullptr;
					for (unit_id id : st.campaign_ai[0].attack_party) {
						unit_t* candidate = functions.get_unit(id);
						if (candidate && !functions.unit_dying(candidate) && functions.unit_can_attack(candidate)) { attacker = candidate; break; }
					}
					if (attacker) {
						for (unit_t* target : ptr(st.player_units[1])) {
							if (functions.unit_dying(target) || !functions.unit_is(target, UnitTypes::Protoss_Probe)) continue;
							if (!functions.is_reachable(attacker, target)) {
								functions.move_unit(target, attacker->sprite->position + xy(96, 0));
								functions.refresh_unit_position(target);
							}
							require(functions.is_reachable(attacker, target), "the PB4A attack fixture keeps an original Probe on reachable terrain");
							reachable_target = true;
							break;
						}
					}
				}
				for (unit_id id : st.campaign_ai[0].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (unit && !functions.unit_dying(unit) && (unit->ground_weapon_cooldown || unit->air_weapon_cooldown)) fired = true;
				}
			}
			require(reachable_target && fired && !st.players[1].victory_state, "PB4A follows its authored waits and attacks with native weapons");
		} else if (scenario == 2) {
			unit_t* nexus = nullptr;
			for (unit_t* unit : ptr(st.player_units[1])) if (functions.unit_is(unit, UnitTypes::Protoss_Nexus)) nexus = unit;
			require(nexus && st.trigger_switches[99], "the original building-loss gate is armed after the start");
			functions.kill_unit(nexus);
			for (int tick = 0; tick != 256 && !st.players[1].victory_state; ++tick) step();
			require(st.players[1].victory_state == 2, "losing the final original human building reaches the authored defeat");
		} else {
			a_vector<unit_t*> enemy_buildings;
			for (unit_t* unit : ptr(st.player_units[5])) if (functions.ut_building(unit) && !functions.unit_dying(unit)) enemy_buildings.push_back(unit);
			require(enemy_buildings.size() >= 2, "the original Terran owner supplies the two-building progression gate");
			functions.kill_unit(enemy_buildings[0]);
			functions.kill_unit(enemy_buildings[1]);
			for (int tick = 0; tick != 256 && !st.trigger_switches[3]; ++tick) step();
			require(st.trigger_switches[3] && st.unit_counts[2][UnitTypes::Protoss_Shuttle] == 4, "destroying two original Terran buildings creates the source Shuttle");
			unit_t* shuttle = nullptr;
			for (unit_t* unit : ptr(st.player_units[2])) if (functions.unit_is(unit, UnitTypes::Protoss_Shuttle) && !functions.unit_dying(unit)) { shuttle = unit; break; }
			require(shuttle, "the original rescue Shuttle is available for the authored drop");
			const auto& drop = st.locations.at(2).area;
			functions.move_unit(shuttle, (drop.from + drop.to) / 2);
			functions.refresh_unit_position(shuttle);
			for (int tick = 0; tick != 3000 && !st.trigger_switches[5]; ++tick) step();
			require(st.trigger_switches[5] && st.current_minerals[1] == 1000 && st.current_gas[1] == 100 && st.unit_counts[1][UnitTypes::Protoss_Probe] == 8, "the original Shuttle drop creates four human Probes and grants only its authored resources");
			for (int tick = 0; tick != 512 && !st.trigger_switches[6]; ++tick) step();
			require(st.trigger_switches[6] && st.unit_counts[1][UnitTypes::Hero_Infested_Kerrigan] > 0, "the original Kerrigan presence is naturally rescued and arms its survival gate");
			require(!st.players[1].victory_state, "the Uraj crystal must reach the original Kerrigan before victory");
			if (scenario == 1) {
				unit_t* kerrigan = nullptr;
				for (unit_t* unit : ptr(st.player_units[1])) if (functions.unit_is(unit, UnitTypes::Hero_Infested_Kerrigan) && !functions.unit_dying(unit)) { kerrigan = unit; break; }
				unit_t* uraj = nullptr;
				for (unit_t* unit : ptr(st.player_units[6])) if (functions.unit_is(unit, UnitTypes::Powerup_Uraj_Crystal) && !functions.unit_dying(unit)) { uraj = unit; break; }
				unit_t* probe = nullptr;
				for (unit_t* unit : ptr(st.player_units[1])) if (functions.unit_is(unit, UnitTypes::Protoss_Probe) && !functions.unit_dying(unit)) { probe = unit; break; }
				require(kerrigan && uraj && probe, "the original Kerrigan, Uraj and Probe remain available for the source outcome gate");
				unit_id kerrigan_id = functions.get_unit_id(kerrigan), probe_id = functions.get_unit_id(probe);
				functions.set_unit_order(kerrigan, functions.get_order_type(Orders::HoldPosition));
				functions.move_unit(probe, uraj->sprite->position);
				functions.refresh_unit_position(probe);
				for (int tick = 0; tick != 128; ++tick) {
					probe = functions.get_unit(probe_id);
					if (!probe || probe->worker.powerup) break;
					step();
				}
				probe = functions.get_unit(probe_id);
				require(probe && probe->worker.powerup == uraj && uraj->owner == 1, "an original Probe naturally carries the original Uraj crystal");
				kerrigan = functions.get_unit(kerrigan_id);
				functions.move_unit(probe, kerrigan->sprite->position);
				functions.refresh_unit_position(probe);
				bool paused = false;
				for (int tick = 0; tick != 5000 && !st.players[1].victory_state; ++tick) { step(); paused = paused || st.scripted_pause; }
				require(paused && st.trigger_switches[7] && st.players[1].victory_state >= 3, "the original Uraj/Kerrigan gate runs the scripted ending and victory");
			} else {
				a_vector<unit_t*> kerrigans;
				for (unit_t* unit : ptr(st.player_units[1])) if (functions.unit_is(unit, UnitTypes::Hero_Infested_Kerrigan) && !functions.unit_dying(unit)) kerrigans.push_back(unit);
				require(!kerrigans.empty(), "the original human Kerrigan is available for its survival predicate");
				for (unit_t* unit : kerrigans) functions.kill_unit(unit);
				for (int tick = 0; tick != 3000 && !st.players[1].victory_state; ++tick) step();
				require(st.players[1].victory_state == 2 && !st.trigger_switches[7], "losing the naturally rescued Kerrigan reaches the independent authored defeat");
			}
		}
		printf("Quest for Uraj original mission case %d passed.\n", scenario);
	}
}

static void dunes_shakuras_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 10; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		require(st.game->scenario_format == 205 && st.players[5].race == race_t::protoss && st.unit_counts[5][UnitTypes::Protoss_Probe] == 4 && st.unit_counts[5][UnitTypes::Protoss_Zealot] == 4 && !st.building_counts[5] && st.unit_counts[1][UnitTypes::Protoss_Dark_Templar] == 4, "Dunes of Shakuras retains its original baseless four-Probe/four-Zealot start and four allied expansion Dark Templars");
		for (unit_t* unit : ptr(st.player_units[5])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (int owner : {1, 5}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		require(st.current_minerals[5] == 600 && st.current_gas[5] == 0 && !st.players[5].victory_state && !st.campaign_ai[4].town_active && st.alliances[5][1] == 1, "source funding, initial alliance and inactive main Zerg AI remain authored");
		if (scenario <= 2) {
			if (scenario) {
				require(functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Protoss_Pylon), xy(1856, 800), 5), "isolated defeat fixture creates one native Pylon");
				for (int tick = 0; tick != 64; ++tick) step();
				require(st.trigger_switches[0], "the source remembers the first human building");
			}
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[5])) if ((scenario == 2 ? functions.ut_building(unit) : !functions.ut_building(unit)) && !functions.unit_dying(unit)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
			for (int tick = 0; tick != 300 && !st.players[5].victory_state; ++tick) step();
			if (scenario == 1) require(!st.players[5].victory_state && st.building_counts[5] == 1, "after establishing a building, army loss alone does not satisfy the source defeat predicate");
			else require(st.players[5].victory_state == 2, "the original pre-base army-loss or post-base building-loss predicate causes defeat");
		} else if (scenario <= 4) {
			unit_t* remaining = nullptr;
			for (unit_t* unit : ptr(st.player_units[4])) if (functions.ut_building(unit)) remaining = unit;
			require(remaining, "the original Zerg town supplies enemy buildings");
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[4])) if (functions.ut_building(unit) && (scenario == 4 || unit != remaining)) victims.push_back(unit);
			for (unit_t* unit : victims) functions.kill_unit(unit);
			bool paused = false;
			for (int tick = 0; tick != 4000 && !st.players[5].victory_state; ++tick) { step(); paused = paused || st.scripted_pause; }
			if (scenario == 3) require(!st.players[5].victory_state && st.building_counts[4] == 1, "one surviving original Zerg building blocks the Dunes victory");
			else require(paused && st.trigger_switches[9] && st.players[5].victory_state >= 3, "destroying all original main-town buildings runs the original paused ending and victory");
		} else {
			const int zealots = 9 - scenario;
			int retained = 0;
			a_vector<unit_t*> victims;
			for (unit_t* unit : ptr(st.player_units[5])) if (functions.unit_is(unit, UnitTypes::Protoss_Zealot)) {
				if (retained < zealots) {
					functions.move_unit(unit, xy(400 + retained * 48, 480));
					functions.refresh_unit_position(unit);
					++retained;
				} else victims.push_back(unit);
			}
			for (unit_t* unit : victims) functions.kill_unit(unit);
			require(functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Protoss_Nexus), xy(608, 400), 5) && functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Protoss_Pylon), xy(608, 560), 5), "isolated encounter fixtures establish the original Nexus/Pylon activation predicate");
			for (int tick = 0; tick != 128 && !st.unit_counts[3][UnitTypes::Zerg_Hydralisk]; ++tick) step();
			const int expected[] = {6, 7, 9, 10, 12};
			require(st.unit_counts[3][UnitTypes::Zerg_Hydralisk] == expected[zealots], "the original encounter selects the exact six-site Hydralisk count for zero through four surviving Zealots");
			if (scenario == 5) {
				st.trigger_switches[1] = true;
				bool fired = false;
				for (int tick = 0; tick != 12000 && !fired; ++tick) {
					step();
					for (unit_id id : st.campaign_ai[4].attacking) {
						unit_t* unit = functions.get_unit(id);
						if (unit && !functions.unit_dying(unit) && unit->ground_weapon_cooldown) fired = true;
					}
				}
				require(st.campaign_ai[4].town_active && st.campaign_ai[4].unit_limits[UnitTypes::Zerg_Zergling] == std::make_pair(true, 16) && st.campaign_ai[4].target_expansion && fired, "the original PB2A program honors unit limits and fires native weapons after its authored build and attack waits");
				require(st.custom_score[7] >= 4 && st.trigger_switches[7] && st.trigger_switches[8], "original preserved custom-score actions activate both staged encounter switches");
				auto original_limit = st.campaign_ai[4].unit_limits[UnitTypes::Zerg_Zergling];
				st.campaign_ai[4].unit_limits[UnitTypes::Zerg_Zergling] = {true, 0};
				int minerals = st.current_minerals[4], gas = st.current_gas[4];
				require(!functions.campaign_ai_produce(4, functions.get_unit_type(UnitTypes::Zerg_Zergling)) && st.current_minerals[4] == minerals && st.current_gas[4] == gas, "a defined zero unit limit blocks actual production without spending resources");
				st.campaign_ai[4].unit_limits[UnitTypes::Zerg_Zergling] = original_limit;
			}
		}
		printf("Dunes of Shakuras original mission case %d passed.\n", scenario);
	}
}

static void escape_aiur_mission_cases(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	for (int scenario = 0; scenario != 5; ++scenario) {
		game_player player(load_data_file);
		data_loading::mpq_file<> map_loader(map_file);
		game_load_functions loader(player.st());
		loader.setup_info.starting_minerals = 0;
		loader.load_map(map_loader);
		auto& st = player.st();
		st.strict_triggers = true;
		state_functions functions(st);
		require(st.game->scenario_format == 205 && st.players[2].controller == player_t::controller_occupied && st.players[2].race == race_t::protoss && st.unit_counts[2][UnitTypes::Hero_Zeratul] == 1 && !st.building_counts[2], "Escape from Aiur retains the original expansion format, human slot, Zeratul and baseless start");
		unit_t* zeratul = nullptr;
		for (unit_t* unit : ptr(st.player_units[2])) if (functions.unit_is(unit, UnitTypes::Hero_Zeratul)) zeratul = unit;
		require(zeratul, "the original Zeratul supplies the escape and survival predicates");
		functions.set_unit_order(zeratul, functions.get_order_type(Orders::HoldPosition));
		auto step = [&]() {
			for (int owner : {2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
				unit->defensive_matrix_hp = fp8::integer(64000);
				unit->defensive_matrix_timer = 250;
			}
			functions.next_frame();
		};
		for (int tick = 0; tick != 64; ++tick) step();
		require(!st.players[2].victory_state && !st.current_minerals[2] && !st.current_gas[2] && !st.countdown_active && st.campaign_ai[3].area_towns.size() == 1 && st.campaign_ai[4].area_towns.size() == 1 && st.campaign_ai_scripts.size() == 2, "both expansion Zerg area programs run while the source retains its zero-resource, untimed opening");
		for (const auto& script : st.campaign_ai_scripts) require(script.broodwar, "Escape from Aiur uses the original expansion AI bytes");
		if (scenario == 0) {
			for (int tick = 0; tick != 1200; ++tick) step();
			require(!st.players[2].victory_state && !st.trigger_switches[43], "waiting at the original start cannot complete the escape objective");
		} else if (scenario == 1) {
			functions.kill_unit(zeratul);
			for (int tick = 0; tick != 500 && !st.players[2].victory_state; ++tick) step();
			require(st.players[2].victory_state == 2, "Zeratul death runs the original delayed defeat sequence");
		} else if (scenario == 2) {
			const auto& area = st.locations[21].area;
			require(functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Protoss_Zealot), (area.from + area.to) / 2, 2), "isolated nonhero gate fixture has an ordinary Zealot");
			for (int tick = 0; tick != 1200; ++tick) step();
			require(!st.trigger_switches[43] && !st.players[2].victory_state, "an ordinary unit at the Warp Gate cannot substitute for Zeratul");
		} else if (scenario == 3) {
			const auto& area = st.locations[21].area;
			functions.move_unit(zeratul, (area.from + area.to) / 2);
			functions.refresh_unit_position(zeratul);
			bool paused = false, raynor = false, fenix = false;
			for (int tick = 0; tick != 5000 && !st.players[2].victory_state; ++tick) {
				step();
				paused = paused || st.scripted_pause;
				raynor = raynor || st.unit_counts[2][UnitTypes::Hero_Jim_Raynor_Vulture] > 0;
				fenix = fenix || st.unit_counts[2][UnitTypes::Hero_Fenix_Dragoon] > 0;
			}
			require(paused && st.trigger_switches[43] && st.trigger_switches[45] && raynor && fenix && st.players[2].victory_state >= 3, "the original Warp Gate, shuttle arrivals, Raynor/Fenix conversation and departure reach native victory");
		} else {
			unit_t* rescue = nullptr;
			for (unit_t* unit : ptr(st.player_units[5])) if (functions.unit_is(unit, UnitTypes::Protoss_Dragoon) && unit->sprite->position.y < 500) rescue = unit;
			require(rescue, "original rescue-owned Dragoons remain present");
			unit_id id = functions.get_unit_id(rescue);
			xy destination = rescue->sprite->position + xy(-48, 0);
			functions.move_unit(zeratul, destination + xy(-160, 0));
			functions.refresh_unit_position(zeratul);
			functions.issue_order(zeratul, false, functions.get_order_type(Orders::Move), {destination, nullptr});
			for (int tick = 0; tick != 600 && functions.get_unit(id)->owner == 5; ++tick) step();
			require(functions.get_unit(id) && functions.get_unit(id)->owner == 2, "normal native movement rescues the same original Dragoon rather than granting a replacement");
		}
		printf("Escape from Aiur original mission case %d passed.\n", scenario);
	}
}

static void expansion_ai_binary_checks(data_loading::data_files_loader<>& load_data_file, const char* map_file) {
	game_player player(load_data_file);
	data_loading::mpq_file<> map_loader(map_file);
	game_load_functions loader(player.st());
	loader.setup_info.starting_minerals = 0;
	loader.load_map(map_loader);
	auto& st = player.st();
	state_functions functions(st);
	st.players[4].controller = player_t::controller_computer_game;
	functions.start_campaign_ai_script(4, 0x41314250, rect{xy(0, 0), xy(640, 640)});
	functions.start_campaign_ai_script(4, 0x42314250, rect{xy(640, 640), xy(1280, 1280)});
	require(st.campaign_ai_scripts.size() == 2 && st.campaign_ai_scripts[0].broodwar && st.campaign_ai_scripts[0].position == 4 && st.campaign_ai_scripts[1].broodwar && st.campaign_ai_scripts[1].position == 25, "zero-offset original headers route both adjacent eight-byte expansion entries to their actual binary");
	functions.progress_campaign_ai_scripts();
	require(st.campaign_ai[4].campaign && st.campaign_ai[4].area_towns.size() == 2 && !st.campaign_ai[4].default_build && st.campaign_ai_scripts[0].wait > 0 && st.campaign_ai_scripts[1].wait > 0, "both original expansion programs execute their own town setup and authored waits");
	functions.start_campaign_ai_script(4, 0x63697553);
	require(!st.campaign_ai_scripts.back().broodwar, "ordinary AI programs continue using the original binary");
	st.campaign_ai_scripts.clear();
	for (auto& ai : st.campaign_ai) ai.town_active = false;
	functions.start_campaign_ai_script(4, 0x3269562b);
	functions.progress_campaign_ai_scripts();
	require(st.shared_vision[2] & (1 << 4), "shared-vision binary opcode grants vision in the same direction as the original trigger helper");
	functions.start_campaign_ai_script(4, 0x3269562d);
	functions.progress_campaign_ai_scripts();
	require(!(st.shared_vision[2] & (1 << 4)), "shared-vision binary opcode removes the matching grant");
	auto original_alliances = st.alliances;
	functions.start_campaign_ai_script(4, 0x796d6e45);
	functions.progress_campaign_ai_scripts();
	for (int player = 0; player != 8; ++player) require(st.alliances[4][player] == (player == 4 ? original_alliances[4][player] : 0), "player_enemy changes only the AI owner's relation to other active players");
	for (int owner = 0; owner != 12; ++owner) if (owner != 4) require(st.alliances[owner] == original_alliances[owner], "player_enemy preserves other owners' alliance rows");
	for (int player = 8; player != 12; ++player) require(st.alliances[4][player] == original_alliances[4][player], "player_enemy preserves neutral and unused slots");
	functions.start_campaign_ai_script(1, 0x42374254);
	functions.progress_campaign_ai_scripts();
	require(st.lcg_rand_state == 123456789u, "the original TB7B four-byte operand sets the exact deterministic native seed");
	printf("Original player_enemy AI command passed.\n");
	printf("Original and expansion AI binary routing passed.\n");
}

int main(int argc, char** argv) {
	const char* data_dir = argc > 1 ? argv[1] : "/data";
	const char* map_file = argc > 2 ? argv[2] : "/maps/Benzene.scx";
	int my_player = 0;
	race_t my_race = race_t::terran;
	bool combat_ai = argc > 3 && !strcmp(argv[3], "--test-ai-combat");
	bool campaign = argc > 3 && (!strcmp(argv[3], "--test-campaign") || combat_ai);
	bool backwater = campaign && argc > 4 && !strcmp(argv[4], "terran02");
	bool desperate = campaign && argc > 4 && !strcmp(argv[4], "terran03");
	bool jacobs = campaign && argc > 4 && !strcmp(argv[4], "terran04");
	bool revolution = campaign && argc > 4 && !strcmp(argv[4], "terran05");
	bool norad = campaign && argc > 4 && !strcmp(argv[4], "terran06");
	bool trump = campaign && argc > 4 && !strcmp(argv[4], "terran07");
	bool big_push = campaign && argc > 4 && !strcmp(argv[4], "terran08");
	bool gettysburg = campaign && argc > 4 && !strcmp(argv[4], "terran09");
	bool hammer = campaign && argc > 4 && !strcmp(argv[4], "terran10");
	bool among_ruins = campaign && argc > 4 && !strcmp(argv[4], "zerg01");
	bool egression = campaign && argc > 4 && !strcmp(argv[4], "zerg02");
	bool new_dominion = campaign && argc > 4 && !strcmp(argv[4], "zerg03");
	bool agent_swarm = campaign && argc > 4 && !strcmp(argv[4], "zerg04");
	bool amerigo = campaign && argc > 4 && !strcmp(argv[4], "zerg05");
	bool dark_templar = campaign && argc > 4 && !strcmp(argv[4], "zerg06");
	bool culling = campaign && argc > 4 && !strcmp(argv[4], "zerg07");
	bool eye_for_eye = campaign && argc > 4 && !strcmp(argv[4], "zerg08");
	bool invasion_aiur = campaign && argc > 4 && !strcmp(argv[4], "zerg09");
	bool full_circle = campaign && argc > 4 && !strcmp(argv[4], "zerg10");
	bool first_strike = campaign && argc > 4 && !strcmp(argv[4], "protoss01");
	bool into_flames = campaign && argc > 4 && !strcmp(argv[4], "protoss02");
	bool higher_ground = campaign && argc > 4 && !strcmp(argv[4], "protoss03");
	bool hunt_tassadar = campaign && argc > 4 && !strcmp(argv[4], "protoss04");
	bool choosing_sides = campaign && argc > 4 && !strcmp(argv[4], "protoss05");
	bool into_darkness = campaign && argc > 4 && !strcmp(argv[4], "protoss06");
	bool homeland = campaign && argc > 4 && !strcmp(argv[4], "protoss07");
	bool trial_tassadar = campaign && argc > 4 && !strcmp(argv[4], "protoss08");
	bool shadow_hunters = campaign && argc > 4 && !strcmp(argv[4], "protoss09");
	bool eye_storm = campaign && argc > 4 && !strcmp(argv[4], "protoss10");
	bool escape_aiur = campaign && argc > 4 && !strcmp(argv[4], "bwprotoss01");
	bool dunes_shakuras = campaign && argc > 4 && !strcmp(argv[4], "bwprotoss02");
	bool legacy_xelnaga = campaign && argc > 4 && !strcmp(argv[4], "bwprotoss03");
	bool quest_for_uraj = campaign && argc > 4 && !strcmp(argv[4], "bwprotoss04");
	bool battle_of_braxis = campaign && argc > 4 && !strcmp(argv[4], "bwprotoss05");

	auto load_data_file = data_loading::data_files_directory(data_dir);
	game_player player(load_data_file);

	data_loading::mpq_file<> map_loader(map_file);
	game_load_functions game_load(player.st());
	if (campaign) {
		game_load.setup_info.victory_condition = 0;
		game_load.setup_info.tournament_mode = 0;
		game_load.setup_info.starting_units = 0;
		game_load.setup_info.resource_type = 0;
		game_load.setup_info.starting_minerals = 0;
		game_load.setup_info.create_melee_units_for_player = {};
		game_load.load_map(map_loader);
		if (escape_aiur) {
			escape_aiur_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (dunes_shakuras) {
			dunes_shakuras_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (legacy_xelnaga) {
			legacy_xelnaga_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (quest_for_uraj) {
			quest_for_uraj_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (battle_of_braxis) {
			battle_of_braxis_mission_cases(load_data_file, map_file);
			return 0;
		}
		original_campaign_availability_checks(player.st());
		if (combat_ai) { ownership_transfer_checks(load_data_file, map_file); expansion_ai_binary_checks(load_data_file, map_file); cloaked_targeting_checks(load_data_file, map_file); shared_combat_ai_checks(player.st()); return 0; }
		if (eye_storm) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[1].controller == player_t::controller_occupied && st.players[1].race == race_t::protoss && st.unit_counts[1][UnitTypes::Protoss_Probe] == 4 && st.unit_counts[1][UnitTypes::Hero_Dark_Templar] == 4 && st.unit_counts[1][UnitTypes::Protoss_Nexus] == 1 && st.unit_counts[1][UnitTypes::Protoss_Pylon] == 2 && st.unit_counts[1][UnitTypes::Hero_Gantrithor] + st.unit_counts[2][UnitTypes::Hero_Gantrithor] == 1 && st.unit_counts[1][UnitTypes::Hero_Zeratul] + st.unit_counts[2][UnitTypes::Hero_Zeratul] == 1, "Eye of the Storm retains its original slot-1 Protoss base, classic Dark Templars, Gantrithor and Zeratul");
			for (unit_t* unit : ptr(st.player_units[1])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 1200; ++tick) functions.next_frame();
			require(st.trigger_switches[0] && st.current_minerals[1] == 100 && st.current_gas[1] == 100 && st.unit_counts[1][UnitTypes::Terran_Command_Center] == 1 && st.unit_counts[1][UnitTypes::Terran_Supply_Depot] == 3 && st.unit_counts[1][UnitTypes::Terran_SCV] == 4 && st.unit_counts[1][UnitTypes::Terran_Marine] == 12 && st.unit_counts[1][UnitTypes::Terran_Firebat] == 2 && st.unit_counts[1][UnitTypes::Terran_Barracks] == 1 && st.unit_counts[1][UnitTypes::Terran_Bunker] == 2 && st.unit_counts[1][UnitTypes::Terran_Engineering_Bay] == 1 && st.unit_counts[1][UnitTypes::Terran_Missile_Turret] == 1, "the original setup grants only 100 minerals/gas and creates the exact Terran base and army under the same human owner");
			require(st.unit_counts[1][UnitTypes::Hero_Hyperion] + st.unit_counts[2][UnitTypes::Hero_Hyperion] == 1 && st.unit_counts[3][UnitTypes::Special_Overmind_With_Shell] == 1 && !st.countdown_active && !st.scripted_pause && !st.players[1].victory_state, "the source creates the single original Raynor and retains the live Overmind without a countdown or early outcome");
			require(st.campaign_ai[0].town_active && st.campaign_ai[0].area_towns.size() == 3 && st.campaign_ai[3].town_active && st.campaign_ai_scripts.size() == 5 && !st.campaign_ai[1].town_active, "the original P10C/three Pr10 area programs and P10o start without taking over the human dual-race force");
			bool main_ground_fire = false, overmind_air_fire = false;
			int combat_budget = 22502 + 7500 + 4 * (500 + 180 * 15) + 2 * st.game->map_width;
			for (int tick = 0; tick != combat_budget && !(main_ground_fire && overmind_air_fire); ++tick) {
				for (int owner : {1, 2}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (int owner : {0, 3}) for (unit_id id : st.campaign_ai[owner].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (!unit->ground_weapon_cooldown && !unit->air_weapon_cooldown) continue;
					if (owner == 0 && !functions.u_flying(unit)) main_ground_fire = true;
					if (owner == 3 && functions.u_flying(unit)) overmind_air_fire = true;
				}
			}
			require(main_ground_fire && overmind_air_fire, "both original Eye of the Storm main programs fire native ground/air weapons using authored waits, requests and funding");
			printf("Eye of the Storm original P10C ground and P10o air attacks passed.\n");
			eye_storm_mission_cases(load_data_file, map_file);
			printf("Eye of the Storm original dual-race initialization passed.\n");
			return 0;
		}
		if (shadow_hunters) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[7].controller == player_t::controller_occupied && st.players[7].race == race_t::protoss && st.unit_counts[7][UnitTypes::Protoss_Probe] == 4 && st.unit_counts[7][UnitTypes::Protoss_Zealot] == 6 && st.unit_counts[7][UnitTypes::Protoss_Dragoon] == 2 && st.unit_counts[7][UnitTypes::Protoss_Arbiter] == 1 && !st.building_counts[7] && st.unit_counts[7][UnitTypes::Hero_Fenix_Dragoon] + st.unit_counts[2][UnitTypes::Hero_Fenix_Dragoon] == 1 && st.unit_counts[7][UnitTypes::Hero_Zeratul] + st.unit_counts[2][UnitTypes::Hero_Zeratul] == 1, "Shadow Hunters retains its original mobile force, Arbiter, two original heroes and baseless start");
			for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.current_minerals[7] == 1000 && st.current_gas[7] == 1000 && !st.countdown_active && !st.trigger_switches[0] && !st.trigger_switches[1] && !st.players[7].victory_state && st.unit_counts[5][UnitTypes::Special_Cerebrate] == 1 && st.unit_counts[6][UnitTypes::Special_Cerebrate] == 1, "Shadow Hunters preserves original funding, both Cerebrates and separate completion switches without an invented countdown or outcome");
			require(st.campaign_ai[0].town_active && st.campaign_ai[5].town_active && st.campaign_ai[6].town_active && st.campaign_ai_scripts.size() == 3 && !st.campaign_ai[7].town_active, "the original Pro9/Pr9W/Pr9Y programs start for all three Zerg owners without human AI substitution");
			bool red_ground_fire = false, brown_ground_fire = false, white_air_fire = false;
			int combat_budget = 15502 + 7500 + 9000 + 3 * (500 + 180 * 15) + 2 * st.game->map_width;
			for (int tick = 0; tick != combat_budget && !(red_ground_fire && brown_ground_fire && white_air_fire); ++tick) {
				for (int owner : {2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (int owner : {0, 5, 6}) for (unit_id id : st.campaign_ai[owner].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (!unit->ground_weapon_cooldown && !unit->air_weapon_cooldown) continue;
					if (owner == 0 && !functions.u_flying(unit)) red_ground_fire = true;
					if (owner == 5 && !functions.u_flying(unit)) brown_ground_fire = true;
					if (owner == 6 && functions.u_flying(unit)) white_air_fire = true;
				}
			}
			require(red_ground_fire && brown_ground_fire && white_air_fire, "all three original Shadow Hunters programs fire native ground/air weapons with authored waits, requests and funding");
			printf("Shadow Hunters original Red/Brown ground and White air attacks passed.\n");
			shadow_hunters_mission_cases(load_data_file, map_file);
			printf("Shadow Hunters original initialization passed.\n");
			return 0;
		}
		if (trial_tassadar) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[7].controller == player_t::controller_occupied && st.players[7].race == race_t::protoss && st.unit_counts[7][UnitTypes::Protoss_Probe] == 4 && st.unit_counts[7][UnitTypes::Protoss_Zealot] == 4 && st.unit_counts[7][UnitTypes::Protoss_Dragoon] == 3 && st.unit_counts[7][UnitTypes::Protoss_Carrier] == 1 && st.unit_counts[7][UnitTypes::Protoss_Nexus] == 1 && st.unit_counts[7][UnitTypes::Protoss_Pylon] == 3 && st.unit_counts[0][UnitTypes::Special_Stasis_Cell_Prison] == 1 && st.unit_counts[7][UnitTypes::Hero_Hyperion] + st.unit_counts[2][UnitTypes::Hero_Hyperion] == 1, "The Trial of Tassadar retains its original base, Carrier, Raynor Hyperion and enemy Stasis Cell");
			for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.trigger_switches[13] && st.unit_counts[7][UnitTypes::Hero_Fenix_Dragoon] + st.unit_counts[2][UnitTypes::Hero_Fenix_Dragoon] == 1 && !st.unit_counts[7][UnitTypes::Hero_Tassadar] && !st.unit_counts[2][UnitTypes::Hero_Tassadar] && st.current_minerals[7] == 70 && !st.current_gas[7] && !st.countdown_active && !st.players[7].victory_state, "the original setup creates Fenix and enables his survival guard, grants only seventy minerals and retains Tassadar for the Stasis Cell ending");
			require(st.campaign_ai[3].town_active && st.campaign_ai[3].area_towns.size() == 1 && st.campaign_ai[0].town_active && st.campaign_ai_scripts.size() == 3 && !st.campaign_ai[7].town_active, "the original Pro8/Pr8B and Pr8D programs start without substituting human AI");
			for (unit_t* unit : ptr(st.player_units[7])) if (functions.unit_is(unit, UnitTypes::Protoss_Carrier)) require(!functions.unit_interceptor_count(unit), "the original Carrier starts without invented Interceptors");
			bool area_ground_fire = false, defenders_air_fire = false;
			int combat_budget = 6502 + 4 * (500 + 180 * 15) + 2 * functions.get_unit_type(UnitTypes::Protoss_Scout)->build_time + 2 * st.game->map_width;
			for (int tick = 0; tick != combat_budget && !(area_ground_fire && defenders_air_fire); ++tick) {
				for (int owner : {2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (int owner : {0, 3}) for (unit_id id : st.campaign_ai[owner].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (!unit->ground_weapon_cooldown && !unit->air_weapon_cooldown) continue;
					if (owner == 3 && !functions.u_flying(unit)) area_ground_fire = true;
					if (owner == 0 && functions.u_flying(unit)) defenders_air_fire = true;
				}
			}
			require(area_ground_fire && defenders_air_fire, "original Pro8 ground and Pr8D Scout parties fire native weapons at authored waits, requests and funding");
			printf("The Trial of Tassadar original area-ground and defender-air attacks passed.\n");
			trial_tassadar_mission_cases(load_data_file, map_file);
			printf("The Trial of Tassadar original initialization passed.\n");
			return 0;
		}
		if (homeland) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[7].controller == player_t::controller_occupied && st.players[7].race == race_t::protoss && st.unit_counts[7][UnitTypes::Protoss_Probe] == 2 && st.unit_counts[7][UnitTypes::Protoss_Zealot] == 8 && st.unit_counts[7][UnitTypes::Protoss_Dragoon] == 4 && st.unit_counts[7][UnitTypes::Protoss_Scout] == 1 && st.unit_counts[7][UnitTypes::Protoss_Observer] == 1 && st.unit_counts[7][UnitTypes::Protoss_Nexus] == 1 && st.unit_counts[7][UnitTypes::Protoss_Pylon] == 10, "Homeland retains its original human slot, full Protoss base and starting ground/air force");
			for (UnitTypes hero : {UnitTypes::Hero_Fenix_Dragoon, UnitTypes::Hero_Tassadar, UnitTypes::Hero_Zeratul}) require(st.unit_counts[7][hero] + st.unit_counts[2][hero] == 1, "Homeland preserves the single original Fenix, Tassadar and Zeratul without substitutes");
			for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			bool intro_paused = false;
			for (int tick = 0; tick != 1200; ++tick) { functions.next_frame(); intro_paused = intro_paused || st.scripted_pause; }
			require(intro_paused && !st.scripted_pause && st.current_minerals[7] == 2500 && st.current_gas[7] == 2500 && !st.countdown_active && !st.trigger_switches[0] && !st.players[7].victory_state, "Homeland runs its original paused introduction and preserves 2500 minerals/gas without an invented countdown or outcome");
			require(st.campaign_ai[0].town_active && st.campaign_ai[0].area_towns.size() == 1 && st.campaign_ai[4].town_active && st.campaign_ai_scripts.size() == 3 && !st.campaign_ai[7].town_active && st.unit_counts[0][UnitTypes::Protoss_Nexus] == 2 && st.unit_counts[4][UnitTypes::Protoss_Nexus] == 1, "Homeland starts its three original main/area-town programs while retaining both Conclave forces and all three enemy Nexuses");
			bool conclave_air_fire = false, shrine_ground_fire = false;
			int combat_budget = 4002 + 4 * (500 + 180 * 15) + 2 * functions.get_unit_type(UnitTypes::Protoss_Scout)->build_time + st.game->map_width;
			for (int tick = 0; tick != combat_budget && !(conclave_air_fire && shrine_ground_fire); ++tick) {
				for (int owner : {2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) if (!functions.unit_dying(unit)) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					if (functions.ut_building(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (int owner : {0, 4}) for (unit_id id : st.campaign_ai[owner].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (!unit->ground_weapon_cooldown && !unit->air_weapon_cooldown) continue;
					if (owner == 0 && functions.u_flying(unit)) conclave_air_fire = true;
					if (owner == 4 && !functions.u_flying(unit)) shrine_ground_fire = true;
				}
			}
			require(conclave_air_fire && shrine_ground_fire, "original Pro7 area-town air and Pr7S ground parties fire native weapons at authored waits and funding");
			printf("Homeland original Conclave air and shrine ground attacks passed.\n");
			homeland_mission_cases(load_data_file, map_file);
			printf("Homeland original initialization passed.\n");
			return 0;
		}
		if (into_darkness) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[7].controller == player_t::controller_occupied && st.players[7].race == race_t::protoss && st.unit_counts[7][UnitTypes::Protoss_Zealot] == 2 && !st.building_counts[7] && !st.unit_counts[7][UnitTypes::Protoss_Probe] && st.unit_counts[7][UnitTypes::Hero_Tassadar] + st.unit_counts[2][UnitTypes::Hero_Tassadar] == 1 && st.unit_counts[2][UnitTypes::Hero_Zeratul] == 1 && st.unit_counts[5][UnitTypes::Hero_Dark_Templar] == 8, "Into the Darkness retains its original field force, single heroes and rescuable classic Dark Templars without a base");
			for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.unit_counts[7][UnitTypes::Hero_Tassadar] == 1 && !st.unit_counts[2][UnitTypes::Hero_Tassadar] && st.unit_counts[2][UnitTypes::Hero_Zeratul] == 1 && !st.current_minerals[7] && !st.current_gas[7] && !st.countdown_active && !st.players[7].victory_state && st.campaign_ai_scripts.empty() && !st.campaign_ai[7].town_active && !st.trigger_switches[1] && !st.trigger_switches[5], "Into the Darkness naturally rescues Tassadar but retains Zeratul, security switches, zero resources and dormant source suicide activation");
			into_darkness_mission_cases(load_data_file, map_file);
			printf("Into the Darkness original initialization passed.\n");
			return 0;
		}
		if (choosing_sides) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[7].controller == player_t::controller_occupied && st.players[7].race == race_t::protoss && st.unit_counts[7][UnitTypes::Protoss_Probe] == 4 && st.unit_counts[7][UnitTypes::Protoss_Zealot] == 4 && st.unit_counts[7][UnitTypes::Protoss_Dragoon] == 3 && st.unit_counts[7][UnitTypes::Protoss_Shuttle] == 1 && st.unit_counts[7][UnitTypes::Protoss_Nexus] == 1 && st.unit_counts[7][UnitTypes::Protoss_Pylon] == 3 && st.unit_counts[7][UnitTypes::Protoss_Gateway] == 1 && st.unit_counts[7][UnitTypes::Hero_Tassadar] + st.unit_counts[2][UnitTypes::Hero_Tassadar] == 1, "Choosing Sides retains its original base, Shuttle, army and single original Tassadar");
			for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.unit_counts[7][UnitTypes::Hero_Tassadar] == 1 && !st.unit_counts[2][UnitTypes::Hero_Tassadar] && st.current_minerals[7] == 150 && st.current_gas[7] == 0 && !st.countdown_active && !st.trigger_switches[0] && !st.trigger_switches[4] && !st.players[7].victory_state && st.campaign_ai[3].town_active && st.campaign_ai[4].town_active && st.campaign_ai_scripts.size() == 2 && !st.campaign_ai[7].town_active, "Choosing Sides naturally rescues Tassadar and starts both original Zerg towns while Duke's confrontation remains dormant");
			unit_t* ground_target = nullptr;
			unit_t* ground_base = nullptr;
			for (unit_t* unit : ptr(st.player_units[7])) if (functions.unit_is(unit, UnitTypes::Protoss_Zealot)) ground_target = unit;
			for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is_hatchery(unit)) ground_base = unit;
			require(ground_target && ground_base, "original actors supply an isolated reachable post-landing combat observation");
			xy approach = ground_base->sprite->position + xy(160, 0);
			functions.move_unit(ground_target, approach);
			auto placement = functions.find_unit_placement(ground_target, approach, true);
			require(placement.first, "native placement supplies a legal original landmass target without inventing a route across water");
			functions.move_unit(ground_target, placement.second);
			bool island_air_fire = false, brown_ground_fire = false;
			int combat_budget = 16002 + 3 * (500 + 180 * 15) + 2 * st.game->map_width + 2 * functions.get_unit_type(UnitTypes::Zerg_Mutalisk)->build_time;
			for (int tick = 0; tick != combat_budget && !(island_air_fire && brown_ground_fire); ++tick) {
				for (unit_t* unit : ptr(st.player_units[7])) if (!functions.unit_dying(unit)) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (int owner : {3, 4}) for (unit_id id : st.campaign_ai[owner].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (!unit->ground_weapon_cooldown && !unit->air_weapon_cooldown) continue;
					if (owner == 4 && functions.u_flying(unit)) island_air_fire = true;
					if (owner == 3 && !functions.u_flying(unit)) brown_ground_fire = true;
				}
			}
			require(island_air_fire && brown_ground_fire, "both original Pr5I/Pr5B programs fire native air/ground weapons with authored waits, requests and funding");
			printf("Choosing Sides original Pr5I air and Pr5B ground attacks passed.\n");
			choosing_sides_mission_cases(load_data_file, map_file);
			printf("Choosing Sides original initialization passed.\n");
			return 0;
		}
		if (hunt_tassadar) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[7].controller == player_t::controller_occupied && st.players[7].race == race_t::protoss && st.unit_counts[7][UnitTypes::Protoss_Zealot] == 4 && st.unit_counts[7][UnitTypes::Protoss_Dragoon] == 4 && st.unit_counts[7][UnitTypes::Protoss_High_Templar] == 1 && !st.unit_counts[7][UnitTypes::Protoss_Nexus] && !st.unit_counts[7][UnitTypes::Protoss_Probe] && st.unit_counts[1][UnitTypes::Protoss_Nexus] == 1 && st.unit_counts[1][UnitTypes::Protoss_Probe] == 4 && st.unit_counts[2][UnitTypes::Hero_Tassadar] == 1, "The Hunt for Tassadar retains the original army, rescuable base and Tassadar without direct grants");
			for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.unit_counts[2][UnitTypes::Hero_Jim_Raynor_Vulture] == 1 && st.trigger_switches[13] && !st.trigger_switches[0] && !st.trigger_switches[1] && st.campaign_ai_scripts.empty() && !st.campaign_ai[7].town_active && st.current_minerals[7] == 0 && st.current_gas[7] == 0 && !st.countdown_active && !st.players[7].victory_state, "the original trigger creates rescuable Raynor while resources, objectives and enemy AI remain gated on the meeting");
			hunt_tassadar_mission_cases(load_data_file, map_file);
			printf("The Hunt for Tassadar original initialization passed.\n");
			return 0;
		}
		if (higher_ground) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[7].controller == player_t::controller_occupied && st.players[7].race == race_t::protoss && st.unit_counts[7][UnitTypes::Protoss_Probe] == 4 && st.unit_counts[7][UnitTypes::Protoss_Zealot] == 4 && st.unit_counts[7][UnitTypes::Protoss_Dragoon] == 3 && st.unit_counts[7][UnitTypes::Protoss_Scout] == 3 && st.unit_counts[7][UnitTypes::Protoss_Nexus] == 1 && st.unit_counts[7][UnitTypes::Protoss_Pylon] == 3 && !st.unit_counts[7][UnitTypes::Hero_Fenix_Zealot], "Higher Ground retains the original Protoss base, ground force and three Scouts without an invented Fenix actor");
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.current_minerals[7] == 300 && st.current_gas[7] == 100 && !st.countdown_active && !st.players[7].victory_state && st.campaign_ai[0].town_active && st.campaign_ai[6].town_active && st.campaign_ai_scripts.size() == 2 && !st.campaign_ai[7].town_active, "Higher Ground retains original resources and both Zerg programs without an invented countdown or human AI");
			for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			bool ground_fire = false, air_fire = false;
			int combat_budget = 10502 + 4 * (500 + 180 * 15) + 2 * functions.get_unit_type(UnitTypes::Zerg_Mutalisk)->build_time + st.game->map_width;
			for (int tick = 0; tick != combat_budget && !(ground_fire && air_fire); ++tick) {
				for (unit_t* unit : ptr(st.player_units[7])) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					if (functions.ut_building(unit) && !functions.unit_dying(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (int owner : {0, 6}) for (unit_id id : st.campaign_ai[owner].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (!unit->ground_weapon_cooldown && !unit->air_weapon_cooldown) continue;
					if (owner == 0 && !functions.u_flying(unit)) ground_fire = true;
					if (owner == 6 && functions.u_flying(unit)) air_fire = true;
				}
			}
			require(ground_fire && air_fire, "original Pr3G ground and Pr3R Mutalisk parties fire native weapons at authored waits and funding");
			printf("Higher Ground original Pr3G ground and Pr3R air attacks passed.\n");
			higher_ground_mission_cases(load_data_file, map_file);
			printf("Higher Ground original initialization passed.\n");
			return 0;
		}
		if (into_flames) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[7].controller == player_t::controller_occupied && st.players[7].race == race_t::protoss && st.unit_counts[7][UnitTypes::Protoss_Probe] == 3 && st.unit_counts[7][UnitTypes::Protoss_Zealot] == 4 && st.unit_counts[7][UnitTypes::Protoss_Dragoon] == 2 && st.unit_counts[7][UnitTypes::Protoss_Nexus] == 1 && st.unit_counts[7][UnitTypes::Protoss_Pylon] == 2 && !st.unit_counts[7][UnitTypes::Hero_Fenix_Zealot] && !st.unit_counts[2][UnitTypes::Hero_Fenix_Zealot], "Into the Flames preserves the original base and army while Fenix remains absent before arrival");
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.current_minerals[7] == 170 && !st.current_gas[7] && st.countdown_active && st.countdown_timer > 890 && st.countdown_timer <= 900 && !st.trigger_switches[4] && !st.players[7].victory_state && st.campaign_ai[6].town_active && st.campaign_ai_scripts.size() == 1 && !st.campaign_ai[7].town_active, "Into the Flames retains its original fifteen-minute timer, resources and Pro2 without an early Fenix defeat");
			for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			for (unit_t* unit : ptr(st.player_units[6])) if (functions.unit_is(unit, UnitTypes::Special_Cerebrate)) functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
			bool ground_fire = false, air_fire = false;
			int combat_budget = 7502 + 3 * (500 + 180 * 15) + 2 * functions.get_unit_type(UnitTypes::Zerg_Mutalisk)->build_time + st.game->map_width;
			for (int tick = 0; tick != combat_budget && !(ground_fire && air_fire); ++tick) {
				for (int owner : {2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					if (functions.ut_building(unit) && !functions.unit_dying(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (unit_id id : st.campaign_ai[6].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (unit->ground_weapon_cooldown || unit->air_weapon_cooldown) {
						if (functions.u_flying(unit)) air_fire = true;
						else ground_fire = true;
					}
				}
			}
			require(ground_fire && air_fire, "original Pro2 ground and Mutalisk parties fire native weapons at authored waits and funding");
			printf("Into the Flames original Pro2 ground and air attacks passed.\n");
			into_flames_mission_cases(load_data_file, map_file);
			printf("Into the Flames original initialization passed.\n");
			return 0;
		}
		if (first_strike) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[7].controller == player_t::controller_occupied && st.players[7].race == race_t::protoss && st.unit_counts[7][UnitTypes::Protoss_Zealot] == 6 && st.unit_counts[7][UnitTypes::Protoss_Dragoon] == 2 && !st.building_counts[7] && !st.unit_counts[7][UnitTypes::Protoss_Probe] && !st.unit_counts[7][UnitTypes::Hero_Fenix_Zealot], "First Strike preserves the original slot-7 Protoss army without granting Antioch or Fenix");
			require(st.unit_counts[2][UnitTypes::Hero_Fenix_Zealot] == 1 && st.unit_counts[1][UnitTypes::Protoss_Nexus] == 1, "original Fenix and Antioch remain separately rescuable");
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.current_minerals[7] == 400 && st.current_gas[7] == 100 && !st.players[7].victory_state && !st.countdown_active && st.campaign_ai[0].town_active && st.campaign_ai_scripts.size() == 1 && !st.campaign_ai[7].town_active, "First Strike retains original resources and Pro1 without a human AI substitute");
			for (unit_t* unit : ptr(st.player_units[7])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			bool ground_fire = false, air_fire = false;
			int combat_budget = 15502 + 4 * (500 + 180 * 15) + 2 * functions.get_unit_type(UnitTypes::Zerg_Mutalisk)->build_time + st.game->map_width;
			for (int tick = 0; tick != combat_budget && !(ground_fire && air_fire); ++tick) {
				for (int owner : {1, 2, 7}) for (unit_t* unit : ptr(st.player_units[owner])) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					if (functions.ut_building(unit) && !functions.unit_dying(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (unit_id id : st.campaign_ai[0].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (unit->ground_weapon_cooldown || unit->air_weapon_cooldown) {
						if (functions.u_flying(unit)) air_fire = true;
						else ground_fire = true;
					}
				}
			}
			require(ground_fire && air_fire, "original Pro1 ground and Mutalisk parties fire native weapons at authored waits and funding");
			printf("First Strike original Pro1 ground and air attacks passed.\n");
			first_strike_mission_cases(load_data_file, map_file);
			printf("First Strike original initialization passed.\n");
			return 0;
		}
		if (full_circle) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[3].controller == player_t::controller_occupied && st.players[3].race == race_t::zerg && st.unit_counts[3][UnitTypes::Zerg_Drone] == 3 && st.unit_counts[3][UnitTypes::Zerg_Zergling] == 6 && st.unit_counts[3][UnitTypes::Zerg_Hydralisk] == 3 && st.unit_counts[3][UnitTypes::Zerg_Overlord] == 4 && st.unit_counts[3][UnitTypes::Zerg_Ultralisk] == 1 && st.unit_counts[3][UnitTypes::Zerg_Hatchery] == 1 && st.unit_counts[3][UnitTypes::Zerg_Creep_Colony] == 2 && !st.unit_counts[3][UnitTypes::Hero_Infested_Kerrigan], "Full Circle retains the original human slot, base and starting force without Kerrigan");
			for (unit_t* unit : ptr(st.player_units[3])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.current_minerals[3] == 1000 && st.current_gas[3] == 1000 && !st.players[3].victory_state && !st.countdown_active && !st.scripted_pause && !st.unit_counts[3][UnitTypes::Powerup_Khaydarin_Crystal], "Full Circle preserves original resources without an early crystal, countdown or outcome");
			require(st.campaign_ai[2].town_active && st.campaign_ai[7].town_active && st.campaign_ai[2].area_towns.size() == 1 && st.campaign_ai[7].area_towns.size() == 1 && st.campaign_ai_scripts.size() == 4 && !st.campaign_ai[0].town_active && !st.campaign_ai[3].town_active && !st.trigger_switches[10], "Full Circle starts the four original Teal/Yellow town programs while Red awaits its authored activation");
			unit_t* red_probe = nullptr;
			for (unit_t* unit : ptr(st.player_units[0])) if (functions.unit_is(unit, UnitTypes::Protoss_Probe)) red_probe = unit;
			require(red_probe, "an original Red Probe supplies the final-offensive combat observation gate");
			functions.kill_unit(red_probe);
			bool teal_ground_fire = false, yellow_air_fire = false, red_air_fire = false;
			int combat_budget = 7502 + 3 * (500 + 180 * 15) + 2 * st.game->map_height + 2 * functions.get_unit_type(UnitTypes::Protoss_Scout)->build_time;
			for (int tick = 0; tick != combat_budget && !(teal_ground_fire && yellow_air_fire && red_air_fire); ++tick) {
				for (unit_t* unit : ptr(st.player_units[3])) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					if (functions.ut_building(unit) && !functions.unit_dying(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (int owner : {0, 2, 7}) for (unit_id id : st.campaign_ai[owner].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (!unit->ground_weapon_cooldown && !unit->air_weapon_cooldown) continue;
					if (owner == 2 && !functions.u_flying(unit)) teal_ground_fire = true;
					if (owner == 7 && functions.u_flying(unit)) yellow_air_fire = true;
					if (owner == 0 && functions.u_flying(unit)) red_air_fire = true;
				}
			}
			require(teal_ground_fire && yellow_air_fire && red_air_fire && st.trigger_switches[10] && st.campaign_ai_scripts.size() == 5, "all three original main-town programs fire native ground/air weapons using authored waits and funding");
			printf("Full Circle original Teal ground and Yellow/Red air attacks passed.\n");
			full_circle_mission_cases(load_data_file, map_file);
			printf("Full Circle original initialization passed.\n");
			return 0;
		}
		if (invasion_aiur) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[3].controller == player_t::controller_occupied && st.players[3].race == race_t::zerg && st.unit_counts[3][UnitTypes::Zerg_Drone] == 4 && st.unit_counts[3][UnitTypes::Zerg_Zergling] == 6 && st.unit_counts[3][UnitTypes::Zerg_Hydralisk] == 2 && st.unit_counts[3][UnitTypes::Zerg_Overlord] == 3 && st.unit_counts[3][UnitTypes::Zerg_Hatchery] == 1 && !st.unit_counts[3][UnitTypes::Hero_Infested_Kerrigan], "The Invasion of Aiur retains its original human slot, base and force without granting Kerrigan");
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.current_minerals[3] == 750 && st.current_gas[3] == 750 && !st.players[3].victory_state && st.campaign_ai[2].town_active && !st.campaign_ai[0].town_active && !st.campaign_ai[3].town_active && !st.campaign_ai[6].town_active && st.campaign_ai_scripts.size() == 1 && !st.trigger_switches[10] && !st.trigger_switches[11], "The Invasion of Aiur retains original resources and the initial Teal town without running town AI for rescuable or neutral force members");
			unit_t* scout_target = nullptr;
			for (unit_t* unit : ptr(st.player_units[3])) {
				functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
				if (functions.unit_is(unit, UnitTypes::Zerg_Overlord)) scout_target = unit;
			}
			require(scout_target, "original Overlord activates the Orange combat-observation programs");
			functions.move_unit(scout_target, xy(2048, 2624));
			functions.issue_order(scout_target, false, functions.get_order_type(Orders::Move), {xy(2048, 2752), nullptr});
			bool teal_ground_fire = false, orange_ground_fire = false, orange_air_fire = false;
			int combat_budget = 4500 + 500 + 3 * (1500 + 500 + 180 * 15) + 2 * st.game->map_width + 5 * functions.get_unit_type(UnitTypes::Protoss_Scout)->build_time;
			for (int tick = 0; tick != combat_budget && !(teal_ground_fire && orange_ground_fire && orange_air_fire); ++tick) {
				for (unit_t* unit : ptr(st.player_units[3])) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					if (functions.ut_building(unit) && !functions.unit_dying(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (int owner : {2, 4}) for (unit_id id : st.campaign_ai[owner].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (!unit->ground_weapon_cooldown && !unit->air_weapon_cooldown) continue;
					if (owner == 2 && !functions.u_flying(unit)) teal_ground_fire = true;
					if (owner == 4 && !functions.u_flying(unit)) orange_ground_fire = true;
					if (owner == 4 && functions.u_flying(unit)) orange_air_fire = true;
				}
			}
			require(teal_ground_fire && orange_ground_fire && orange_air_fire && st.trigger_switches[11], "original Zer9 and contact-gated Z9ro ground/air parties fire native weapons at authored waits and funding");
			printf("The Invasion of Aiur original Teal/Orange ground and air attacks passed.\n");
			invasion_aiur_mission_cases(load_data_file, map_file);
			printf("The Invasion of Aiur original initialization passed.\n");
			return 0;
		}
		if (eye_for_eye) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			int linked_canals = 0;
			for (unit_t* unit : ptr(st.player_units[3])) if (functions.unit_is_nydus(unit) && unit->building.nydus.exit && unit->building.nydus.exit->building.nydus.exit == unit && unit->building.nydus.exit->owner == unit->owner) ++linked_canals;
			require(linked_canals == 4, "all four original Nydus Canals retain their two reciprocal source-record links");
			require(st.players[3].controller == player_t::controller_occupied && st.players[3].race == race_t::zerg && st.unit_counts[3][UnitTypes::Hero_Infested_Kerrigan] == 1 && st.unit_counts[3][UnitTypes::Zerg_Drone] == 2 && st.unit_counts[3][UnitTypes::Zerg_Hydralisk] == 6 && st.unit_counts[3][UnitTypes::Zerg_Zergling] == 9 && st.unit_counts[3][UnitTypes::Zerg_Ultralisk] == 2 && st.unit_counts[3][UnitTypes::Zerg_Overlord] == 5 && st.unit_counts[3][UnitTypes::Zerg_Hatchery] == 3 && st.unit_counts[3][UnitTypes::Zerg_Nydus_Canal] == 4, "Eye for an Eye preserves its original human slot, bases, canals and starting force");
			for (unit_t* unit : ptr(st.player_units[3])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 1200; ++tick) {
				for (unit_t* unit : ptr(st.player_units[3])) { unit->defensive_matrix_hp = fp8::integer(64000); unit->defensive_matrix_timer = 250; }
				functions.next_frame();
			}
			require(st.current_minerals[3] == 350 && st.current_gas[3] == 350 && !st.players[3].victory_state && st.campaign_ai[1].town_active && st.campaign_ai[2].town_active && st.campaign_ai_scripts.size() == 2 && !st.campaign_ai[3].town_active, "Eye for an Eye retains original resources and both Protoss town programs without human AI substitution");
			while (st.current_frame < 90 * 16 + 128) {
				for (unit_t* unit : ptr(st.player_units[3])) { unit->defensive_matrix_hp = fp8::integer(64000); unit->defensive_matrix_timer = 250; }
				functions.next_frame();
			}
			require(st.unit_counts[1][(UnitTypes)74] > 0, "the original first escape timer creates a classic Dark Templar actor");
			bool ground_fire = false, air_fire = false;
			int combat_budget = 12502 + 4 * (500 + 180 * 15) + 2 * functions.get_unit_type(UnitTypes::Protoss_Scout)->build_time;
			for (int tick = 0; tick != combat_budget && !(ground_fire && air_fire); ++tick) {
				for (unit_t* unit : ptr(st.player_units[3])) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					if (functions.ut_building(unit) && !functions.unit_dying(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				a_vector<unit_t*> intercepted;
				for (unit_t* unit : ptr(st.player_units[1])) if (functions.unit_is(unit, UnitTypes::Hero_Dark_Templar) && !functions.unit_dying(unit)) intercepted.push_back(unit);
				for (unit_t* unit : intercepted) functions.kill_unit(unit);
				functions.next_frame();
				for (unit_id id : st.campaign_ai[2].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (unit->ground_weapon_cooldown || unit->air_weapon_cooldown) {
						if (functions.u_flying(unit)) air_fire = true;
						else ground_fire = true;
					}
				}
			}
			require(ground_fire && air_fire, "original Zer8 ground and Scout parties fire native weapons at authored timing without extra funding");
			printf("Eye for an Eye original Protoss ground and air attacks passed.\n");
			eye_for_eye_mission_cases(load_data_file, map_file);
			printf("Eye for an Eye original initialization and first Dark Templar escape startup passed.\n");
			return 0;
		}
		if (culling) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[3].controller == player_t::controller_occupied && st.players[3].race == race_t::zerg && st.unit_counts[3][UnitTypes::Zerg_Drone] == 4 && st.unit_counts[3][UnitTypes::Zerg_Hydralisk] == 8 && st.unit_counts[3][UnitTypes::Zerg_Mutalisk] == 4 && st.unit_counts[3][UnitTypes::Zerg_Overlord] == 4 && st.building_counts[3] == 0 && !st.unit_counts[3][UnitTypes::Hero_Infested_Kerrigan], "The Culling retains its original mobile force without a granted base or Kerrigan");
			for (unit_t* unit : ptr(st.player_units[3])) functions.set_unit_order(unit, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.current_minerals[3] == 800 && st.current_gas[3] == 200 && !st.players[3].victory_state && !st.trigger_switches[10] && st.campaign_ai_scripts.empty(), "The Culling preserves original resources and dormant Garm town scripts before activation");
			while (st.current_frame < 300 * 16 + 128) {
				for (unit_t* unit : ptr(st.player_units[3])) { unit->defensive_matrix_hp = fp8::integer(64000); unit->defensive_matrix_timer = 250; }
				for (unit_t* unit : ptr(st.player_units[4])) if (functions.ut_building(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				functions.next_frame();
				if (st.current_frame < 300 * 16) require(!st.trigger_switches[10] && st.campaign_ai_scripts.empty(), "the original timer cannot activate Garm towns before five game minutes when other gates are untouched");
			}
			require(st.trigger_switches[10] && st.campaign_ai_scripts.size() == 4 && st.campaign_ai[4].town_active && st.campaign_ai[4].area_towns.size() == 3 && !st.campaign_ai[3].town_active, "the original five-minute trigger starts all four Garm programs with one main and three area towns");
			bool ground_fire = false, air_fire = false;
			int combat_budget = 18502 + 4 * (500 + 180 * 15) + 2 * functions.get_unit_type(UnitTypes::Zerg_Mutalisk)->build_time;
			for (int tick = 0; tick != combat_budget && !(ground_fire && air_fire); ++tick) {
				for (unit_t* unit : ptr(st.player_units[3])) { unit->defensive_matrix_hp = fp8::integer(64000); unit->defensive_matrix_timer = 250; }
				functions.next_frame();
				for (unit_id id : st.campaign_ai[4].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (unit->ground_weapon_cooldown || unit->air_weapon_cooldown) {
						if (functions.u_flying(unit)) air_fire = true;
						else ground_fire = true;
					}
				}
			}
			require(ground_fire && air_fire, "original Garm ground and Mutalisk parties fire native weapons at authored timing without extra funding");
			printf("The Culling original Garm ground and air attacks passed.\n");
			culling_mission_cases(load_data_file, map_file);
			printf("The Culling original mobile start and timed Garm activation passed.\n");
			return 0;
		}
		if (dark_templar) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[3].controller == player_t::controller_occupied && st.players[3].race == race_t::zerg && st.unit_counts[3][UnitTypes::Hero_Infested_Kerrigan] == 1 && st.unit_counts[3][UnitTypes::Zerg_Drone] == 4 && st.unit_counts[3][UnitTypes::Zerg_Hydralisk] == 4 && st.unit_counts[3][UnitTypes::Zerg_Mutalisk] == 2 && st.unit_counts[3][UnitTypes::Zerg_Guardian] == 2 && st.unit_counts[3][UnitTypes::Zerg_Overlord] == 3 && st.unit_counts[3][UnitTypes::Zerg_Hatchery] == 1, "The Dark Templar retains its original human slot and starting Zerg force");
			for (int tick = 0; tick != 1200; ++tick) functions.next_frame();
			require(st.current_minerals[3] == 250 && st.current_gas[3] == 250 && !st.scripted_pause && !st.players[3].victory_state, "The Dark Templar preserves original opening resources and dialogue without an invented outcome");
			require(st.campaign_ai[1].town_active && st.campaign_ai_scripts.size() == 1 && !st.campaign_ai[3].town_active && !st.unit_counts[2][UnitTypes::Hero_Tassadar], "original Zer6 starts while Tassadar remains reserved for the authored challenge");
			bool ground_fire = false, air_fire = false;
			int combat_budget = 21502 + 4 * (500 + 180 * 15) + 2 * functions.get_unit_type(UnitTypes::Protoss_Scout)->build_time;
			for (int tick = 0; tick != combat_budget && !(ground_fire && air_fire); ++tick) {
				for (unit_t* unit : ptr(st.player_units[3])) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					if (functions.ut_building(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (unit_id id : st.campaign_ai[1].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (unit->ground_weapon_cooldown || unit->air_weapon_cooldown) {
						if (functions.u_flying(unit)) air_fire = true;
						else ground_fire = true;
					}
				}
			}
			require(ground_fire && air_fire, "original Zer6 ground and Scout waves fire native weapons at authored timing without extra funding");
			printf("The Dark Templar original Protoss ground and air attacks passed.\n");
			dark_templar_mission_cases(load_data_file, map_file);
			printf("The Dark Templar original initialization and AI startup passed.\n");
			return 0;
		}
		if (amerigo) {
			require(player.st().players[3].controller == player_t::controller_occupied && player.st().players[3].race == race_t::zerg && player.st().unit_counts[3][UnitTypes::Hero_Infested_Kerrigan] == 1 && player.st().unit_counts[3][UnitTypes::Zerg_Zergling] == 6, "The Amerigo retains original Kerrigan and six Zerglings with human slot three");
			amerigo_mission_cases(load_data_file, map_file);
			printf("The Amerigo original initialization and indoor control checks passed.\n");
			return 0;
		}
		if (agent_swarm) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(state_functions::campaign_action_supported(25), "original scene Remove Unit At Location is available to the campaign runtime");
			require(st.players[3].controller == player_t::controller_occupied && st.players[3].race == race_t::zerg && st.unit_counts[3][UnitTypes::Zerg_Drone] == 3 && st.unit_counts[3][UnitTypes::Zerg_Queen] == 2 && st.unit_counts[3][UnitTypes::Zerg_Zergling] == 6 && st.unit_counts[3][UnitTypes::Zerg_Hydralisk] == 4, "Agent of the Swarm preserves original Zerg starting forces");
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.current_minerals[3] == 250 && st.current_gas[3] == 250 && st.countdown_timer > 590 && st.countdown_timer <= 600, "Agent of the Swarm retains original resources and ten-minute hatch countdown");
			require(st.campaign_ai[1].town_active && st.campaign_ai_scripts.size() == 2 && !st.campaign_ai[3].town_active, "original Zer4 and Ze4S start without human AI substitution");
			agent_swarm_mission_cases(load_data_file, map_file);
			printf("Agent of the Swarm original initialization and timed hatch passed.\n");
			return 0;
		}
		if (new_dominion) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[3].controller == player_t::controller_occupied && st.players[3].race == race_t::zerg, "The New Dominion preserves original human Zerg slot three");
			require(st.unit_counts[3][UnitTypes::Zerg_Hatchery] == 1 && st.unit_counts[3][UnitTypes::Zerg_Drone] == 2 && st.unit_counts[3][UnitTypes::Zerg_Hydralisk] == 4 && st.unit_counts[3][UnitTypes::Zerg_Mutalisk] == 4 && st.unit_counts[3][UnitTypes::Special_Mature_Chrysalis] == 1, "The New Dominion preserves original human starting forces and Chrysalis");
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.current_minerals[3] == 150 && st.current_gas[3] == 50 && !st.players[3].victory_state, "The New Dominion retains original opening resources and idle state");
			require(st.campaign_ai[6].town_active && st.campaign_ai_scripts.size() == 1 && !st.campaign_ai[3].town_active, "The New Dominion starts original Zer3 without controlling the human");
			campaign_audio_bounds_checks();
			bool ground_fire = false, air_fire = false;
			int combat_budget = 15502 + 4 * (500 + 180 * 15) + 2 * functions.get_unit_type(UnitTypes::Terran_Wraith)->build_time;
			for (int tick = 0; tick != combat_budget && !(ground_fire && air_fire); ++tick) {
				for (unit_t* unit : ptr(st.player_units[3])) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					if (functions.ut_building(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (unit_id id : st.campaign_ai[6].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (unit->ground_weapon_cooldown || unit->air_weapon_cooldown) {
						if (functions.u_flying(unit)) air_fire = true;
						else ground_fire = true;
					}
				}
			}
			require(ground_fire && air_fire, "original Zer3 deploys weapon-firing ground and air parties");
			printf("The New Dominion original Terran ground and air attacks passed.\n");
			new_dominion_mission_cases(load_data_file, map_file);
			printf("The New Dominion original initialization and AI startup passed.\n");
			return 0;
		}
		if (egression) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[3].controller == player_t::controller_occupied && st.players[3].race == race_t::zerg, "Egression preserves original human Zerg slot three");
			require(st.unit_counts[3][UnitTypes::Zerg_Hatchery] == 2 && st.unit_counts[3][UnitTypes::Zerg_Drone] == 2 && st.unit_counts[3][UnitTypes::Zerg_Hydralisk] == 3 && st.unit_counts[3][UnitTypes::Zerg_Mutalisk] == 2 && st.unit_counts[3][UnitTypes::Zerg_Overlord] == 3, "Egression preserves original Zerg starting forces");
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.current_minerals[3] == 300 && st.current_gas[3] == 0, "Egression original opening grants three hundred minerals and no gas");
			unit_t* chrysalis = nullptr;
			unit_t* worker = nullptr;
			int portable_count = 0;
			for (unit_t* unit : ptr(st.player_units[3])) {
				if (functions.unit_is(unit, UnitTypes::Special_Zerg_Beacon)) chrysalis = unit;
				if (functions.unit_is(unit, UnitTypes::Zerg_Drone)) worker = unit;
			}
			for (int owner : all_player_slots) portable_count += st.unit_counts[owner][UnitTypes::Powerup_Young_Chrysalis];
			require(chrysalis && worker, "Egression preserves its original standing Chrysalis and Drone");
			require(portable_count == 1 && st.unit_counts[11][UnitTypes::Powerup_Young_Chrysalis] == 1, "Egression retains exactly its original neutral portable Chrysalis");
			require(!st.players[3].victory_state && !st.campaign_ai[3].town_active, "Egression neither invents an opening outcome nor enables human AI");
			require(st.campaign_ai[1].town_active && st.campaign_ai_scripts.size() == 1, "Egression starts its original Protoss Zer2 town program");
			printf("Egression original initialization, standing Chrysalis and AI startup passed.\n");
			functions.move_unit(worker, chrysalis->sprite->position);
			functions.set_unit_order(worker, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 64 && !worker->worker.powerup; ++tick) functions.next_frame();
			require(worker->worker.powerup && functions.unit_is(worker->worker.powerup, UnitTypes::Powerup_Young_Chrysalis), "a Drone entering the original Chrysalis picks up its native portable form");
			require(!functions.unit_dying(chrysalis) && functions.us_hidden(worker->worker.powerup) && worker->worker.powerup->owner == worker->owner, "pickup carries the original Chrysalis with native worker ownership while preserving the source beacon");
			printf("Egression native Chrysalis pickup passed.\n");
			bool ground_fire = false, air_fire = false;
			int combat_budget = 17002 + 4 * 180 * 15 + 2 * functions.get_unit_type(UnitTypes::Protoss_Scout)->build_time + 2000;
			for (int tick = 0; tick != combat_budget && !(ground_fire && air_fire); ++tick) {
				for (unit_t* unit : ptr(st.player_units[3])) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					if (functions.ut_building(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (unit_id id : st.campaign_ai[1].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (unit->ground_weapon_cooldown || unit->air_weapon_cooldown) {
						if (functions.u_flying(unit)) air_fire = true;
						else ground_fire = true;
					}
				}
			}
			if (!(ground_fire && air_fire)) {
				printf("Egression combat diagnostic: frame=%d outcome=%d ground=%d air=%d scouts=%d stargates=%d minerals=%d gas=%d\n", st.current_frame, st.players[3].victory_state, ground_fire, air_fire, st.unit_counts[1][UnitTypes::Protoss_Scout], st.unit_counts[1][UnitTypes::Protoss_Stargate], st.current_minerals[1], st.current_gas[1]);
				for (const auto& script : st.campaign_ai_scripts) printf("Egression script diagnostic: owner=%d position=%zu wait=%d\n", script.owner, script.position, script.wait);
			}
			require(ground_fire && air_fire, "original Zer2 deploys weapon-firing ground and air parties at authored timing");
			printf("Egression original Protoss ground and air attacks passed.\n");
			egression_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (among_ruins) {
			auto& st = player.st();
			state_functions functions(st);
			st.strict_triggers = true;
			require(st.players[3].controller == player_t::controller_occupied && st.players[3].race == race_t::zerg, "Among the Ruins preserves original human Zerg slot three");
			require(st.unit_counts[3][UnitTypes::Zerg_Hatchery] == 1 && st.unit_counts[3][UnitTypes::Zerg_Drone] == 2 && st.unit_counts[3][UnitTypes::Zerg_Zergling] == 12 && st.unit_counts[3][UnitTypes::Zerg_Overlord] == 1, "Among the Ruins preserves original Zerg starting forces");
			for (int tick = 0; tick != 64; ++tick) functions.next_frame();
			require(st.current_minerals[3] == 200 && st.current_gas[3] == 0, "Among the Ruins original opening grants two hundred minerals and no gas");
			require(!st.players[3].victory_state && !st.campaign_ai[5].town_active, "initial idle state neither wins nor bypasses the enemy AI activation deadline");
			printf("Among the Ruins original Zerg initialization passed.\n");
			among_ruins_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (hammer) {
			player.st().strict_triggers = true;
			state_functions functions(player.st());
			require(player.st().players[1].controller == player_t::controller_occupied, "The Hammer Falls preserves original human slot one");
			require(player.st().players[0].force != player.st().players[6].force && player.st().alliances[0][6] && player.st().alliances[6][0], "original UMS computers begin allied across different forces");
			require(!player.st().alliances[0][1] && !player.st().alliances[6][1] && !player.st().alliances[1][0] && !player.st().alliances[1][6], "both Hammer Falls enemy forces remain hostile to the human");
			for (int tick = 0; tick != 32; ++tick) functions.next_frame();
			require(player.st().current_minerals[1] == 500 && player.st().current_gas[1] == 150, "original Hammer Falls starting resources");
			require(!player.st().players[1].victory_state, "The Hammer Falls does not invent an opening outcome");
			printf("The Hammer Falls normal initialization passed.\n");
			for (unit_t* unit : ptr(player.st().player_units[1])) functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
			for (unit_t* unit : ptr(player.st().player_units[6])) if (unit->unit_type->id == UnitTypes::Special_Ion_Cannon) functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
			int rate_budget = 15000 + 2 * functions.get_unit_type(UnitTypes::Terran_Control_Tower)->build_time + 1000;
			for (int tick = 0; tick != rate_budget && !player.st().campaign_ai[6].nuke_interval; ++tick) functions.next_frame();
			require(player.st().campaign_ai[6].nuke_interval == 15 * 60 * 15, "original T12N fifteen-minute nuke rate is retained");
			printf("The Hammer Falls original nuclear cadence parsed.\n");
			auto& nuclear_ai = player.st().campaign_ai[6];
			int original_due = nuclear_ai.next_nuke_frame;
			require(!functions.try_campaign_ai_nuke(6) && nuclear_ai.next_nuke_frame == original_due, "missing ready missile cannot reset the authored nuclear cadence");
			bool missile_ready = false;
			bool launched = false;
			std::array<bool, 2> ground_fire{};
			std::array<bool, 2> air_fire{};
			int combat_deadline = 45502 + 4 * (500 + 180 * 15) + 2 * functions.get_unit_type(UnitTypes::Terran_Battlecruiser)->build_time;
			while (player.st().current_frame < combat_deadline && !(launched && ground_fire[0] && ground_fire[1] && air_fire[0] && air_fire[1])) {
				for (unit_t* unit : ptr(player.st().player_units[1])) {
					functions.u_set_status_flag(unit, unit_t::status_flag_invincible, unit->unit_type->id == UnitTypes::Hero_Jim_Raynor_Vulture);
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					if (functions.ut_building(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (unit_t* unit : ptr(player.st().player_units[6])) {
					if (unit->unit_type->id == UnitTypes::Terran_Nuclear_Silo && unit->building.silo.ready) missile_ready = true;
					if (unit->unit_type->id == UnitTypes::Terran_Ghost && unit->order_type->id == Orders::NukeTrack && unit->connected_unit && unit->connected_unit->unit_type->id == UnitTypes::Terran_Nuclear_Missile) launched = true;
				}
				for (int index = 0; index != 2; ++index) for (unit_id id : player.st().campaign_ai[index ? 6 : 0].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					const unit_t* attacker = functions.unit_attacking_unit(unit);
					if (attacker->ground_weapon_cooldown || attacker->air_weapon_cooldown) {
						if (functions.u_flying(unit)) air_fire[index] = true;
						else ground_fire[index] = true;
					}
				}
				if (player.st().current_frame < original_due) require(!launched && nuclear_ai.next_nuke_frame == original_due, "scripted nuclear launch cannot run before its original cadence");
			}
			require(missile_ready && launched && nuclear_ai.next_nuke_frame > original_due, "T12N pays for a native missile and launches it through an original Ghost at the scripted cadence");
			if (!ground_fire[0] || !ground_fire[1] || !air_fire[0] || !air_fire[1]) {
				printf("Hammer combat diagnostic: frame=%d outcome=%d ground0=%d air0=%d ground6=%d air6=%d human_actors=%d human_buildings=%d\n", player.st().current_frame, player.st().players[1].victory_state, ground_fire[0], air_fire[0], ground_fire[1], air_fire[1], count_units(player.st(), 1), player.st().building_counts[1]);
				for (const auto& script : player.st().campaign_ai_scripts) printf("Hammer script state: owner=%d position=%zu wait=%d\n", script.owner, script.position, script.wait);
			}
			require(ground_fire[0] && ground_fire[1] && air_fire[0] && air_fire[1], "both original Hammer Falls enemy scripts deploy weapon-firing ground and air parties");
			printf("The Hammer Falls original paid nuclear production and launch passed.\n");
			printf("The Hammer Falls original ground and air attacks passed.\n");
			hammer_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (gettysburg) {
			player.st().strict_triggers = true;
			require(player.st().players[0].controller == player_t::controller_occupied, "New Gettysburg preserves original human slot zero");
			state_functions functions(player.st());
			for (int tick = 0; tick != 32; ++tick) functions.next_frame();
			require(!player.st().players[0].victory_state, "New Gettysburg does not invent an opening outcome");
			printf("New Gettysburg normal initialization passed.\n");
			for (int owner : {0, 3}) for (unit_t* unit : ptr(player.st().player_units[owner])) functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
			finish_gettysburg_opening(player.st(), functions);
			unit_t* stargate = nullptr;
			for (unit_t* unit : ptr(player.st().player_units[1])) if (unit->unit_type->id == UnitTypes::Protoss_Stargate && unit->sprite->position.y > 2000) stargate = unit;
			require(stargate && player.st().campaign_ai[1].area_towns.size() == 1, "original lower Protoss Stargate and area town");
			functions.kill_unit(stargate);
			bool rebuilt = false;
			int rebuild_budget = 2 * functions.get_unit_type(UnitTypes::Protoss_Stargate)->build_time + 1000;
			for (int tick = 0; tick != rebuild_budget && !rebuilt; ++tick) {
				functions.next_frame();
				for (unit_t* unit : ptr(player.st().player_units[1])) if (unit->unit_type->id == UnitTypes::Protoss_Stargate && !functions.unit_dying(unit) && functions.u_completed(unit) && functions.campaign_ai_unit_town(1, unit) == 1) rebuilt = true;
			}
			require(rebuilt, "original lower Protoss town rebuilds its Stargate through a native Probe");
			printf("New Gettysburg original Protoss reconstruction passed.\n");
			std::array<bool, 2> ground_fire{};
			std::array<bool, 2> air_fire{};
			const int combat_budget = 16500 + 7500 + 6000 + 6000 + 4 * (500 + 180 * 15) + 2 * functions.get_unit_type(UnitTypes::Protoss_Scout)->build_time;
			for (int tick = 0; tick != combat_budget; ++tick) {
				for (int owner : {0, 3}) for (unit_t* unit : ptr(player.st().player_units[owner])) {
					functions.u_set_status_flag(unit, unit_t::status_flag_invincible, unit->unit_type->id == UnitTypes::Hero_Sarah_Kerrigan);
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					if (owner == 0 && functions.ut_building(unit)) functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				functions.next_frame();
				for (int index = 0; index != 2; ++index) for (unit_id id : player.st().campaign_ai[index ? 3 : 1].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (unit->ground_weapon_cooldown || unit->air_weapon_cooldown) {
						if (functions.u_flying(unit)) air_fire[index] = true;
						else ground_fire[index] = true;
					}
				}
				if (ground_fire[0] && ground_fire[1] && air_fire[0] && air_fire[1]) break;
			}
			if (!ground_fire[0] || !ground_fire[1] || !air_fire[0] || !air_fire[1]) {
				printf("Gettysburg combat diagnostic: frame=%d outcome=%d proto_ground=%d proto_air=%d zerg_ground=%d zerg_air=%d scouts=%d pylons=%d proto_minerals=%d proto_gas=%d\n", player.st().current_frame, player.st().players[0].victory_state, ground_fire[0], air_fire[0], ground_fire[1], air_fire[1], player.st().unit_counts[1][UnitTypes::Protoss_Scout], player.st().unit_counts[1][UnitTypes::Protoss_Pylon], player.st().current_minerals[1], player.st().current_gas[1]);
				printf("Gettysburg combat loss: kerrigan=%d human_units=%d\n", player.st().unit_counts[0][UnitTypes::Hero_Sarah_Kerrigan], count_units(player.st(), 0));
				for (size_t type = 0; type != 228; ++type) if (player.st().dead_unit_counts[3][(UnitTypes)type] && (functions.get_unit_type((UnitTypes)type)->group_flags & GroupFlags::Building)) printf("Gettysburg lost Zerg building: type=%zu deaths=%d\n", type, player.st().dead_unit_counts[3][(UnitTypes)type]);
				for (const auto& script : player.st().campaign_ai_scripts) printf("Gettysburg AI state: owner=%d position=%zu wait=%d town=%zu\n", script.owner, script.position, script.wait, script.town);
			}
			require(ground_fire[0] && ground_fire[1] && air_fire[0] && air_fire[1], "original Protoss and Zerg scripts each deploy weapon-firing ground and air parties");
			require(functions.player_has_completed_unit(1, UnitTypes::Protoss_Scout), "original Protoss air request completes through native Stargate training");
			printf("New Gettysburg original Protoss/Zerg ground and air combat passed.\n");
			functions.start_campaign_ai_script(3, 1382643027);
			functions.progress_campaign_ai_scripts();
			bool random_target = false;
			for (unit_t* unit : ptr(player.st().player_units[3])) if (unit->order_target.unit && functions.unit_target_is_enemy(unit, unit->order_target.unit) && unit->order_type->targets_enemies) random_target = true;
			require(random_target && !player.st().campaign_ai[3].suicide, "original SuiR assigns native hostile targets without substituting strategic suicide");
			printf("New Gettysburg original random-suicide script passed.\n");
			gettysburg_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (big_push) {
			player.st().strict_triggers = true;
			state_functions functions(player.st());
			int flying_buildings = 0;
			for (unit_t* unit : ptr(player.st().player_units[0])) if (functions.ut_flying_building(unit)) {
				require(functions.u_flying(unit), "original Big Push in-transit buildings start flying");
				++flying_buildings;
			}
			require(flying_buildings == 6, "original six flying Big Push buildings");
			for (int tick = 0; tick != 32; ++tick) functions.next_frame();
			require(player.st().current_minerals[0] == 250 && player.st().current_gas[0] == 100, "original Big Push starting resources");
			require(!player.st().players[0].victory_state, "The Big Push does not invent an opening outcome");
			printf("The Big Push normal initialization passed.\n");
			big_push_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (trump) {
			player.st().strict_triggers = true;
			require(player.st().players[0].controller == player_t::controller_occupied, "The Trump Card preserves original human slot zero");
			for (int tick = 0; tick != 32; ++tick) player.next_frame();
			require(!player.st().players[0].victory_state, "The Trump Card does not invent an opening outcome");
			unit_t* carrier = nullptr;
			for (unit_t* unit : ptr(player.st().player_units[0])) if (unit->unit_type->id == UnitTypes::Terran_SCV && unit->worker.powerup) carrier = unit;
			require(carrier && carrier->worker.powerup->unit_type->id == UnitTypes::Powerup_Psi_Emitter, "original emitter creation is picked up by its native SCV");
			printf("The Trump Card normal initialization passed.\n");
			state_functions functions(player.st());
			bool ground_fire = false;
			bool air_fire = false;
			int first_air_budget = 2 * functions.get_unit_type(UnitTypes::Terran_Control_Tower)->build_time + 3000 + 500 + 1500 + 500 + 2 * 180 * 15;
			for (int tick = 0; tick != first_air_budget; ++tick) {
				for (unit_t* unit : ptr(player.st().player_units[0])) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
				}
				functions.next_frame();
				for (unit_id id : player.st().campaign_ai[4].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit) || functions.us_hidden(unit)) continue;
					if (unit->ground_weapon_cooldown || unit->air_weapon_cooldown) {
						if (functions.u_flying(unit)) air_fire = true;
						else ground_fire = true;
					}
				}
				if (ground_fire && air_fire && functions.player_upgrade_level(4, (UpgradeTypes)7) >= 1) break;
			}
			require(functions.player_has_completed_unit(4, UnitTypes::Terran_Control_Tower), "Ter8 completes its requested native Control Tower before releasing the wait");
			require(ground_fire && air_fire, "original Ter8 ground and air parties fire native weapons");
			require(functions.player_upgrade_level(4, (UpgradeTypes)7) >= 1, "Ter8 completes its requested native infantry weapon upgrade");
			printf("The Trump Card original construction, upgrades and ground/air attacks passed.\n");
			trump_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (norad) {
			player.st().strict_triggers = true;
			require(player.st().players[0].controller == player_t::controller_occupied, "Norad II preserves the original human slot zero");
			for (int tick = 0; tick != 32; ++tick) player.next_frame();
			require(!player.st().players[0].victory_state, "Norad II does not invent an opening outcome");
			printf("Norad II normal initialization passed.\n");
			state_functions functions(player.st());
			unit_t* worker = nullptr;
			unit_t* base = nullptr;
			for (unit_t* unit : ptr(player.st().player_units[0])) {
				functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
				if (unit->unit_type->id == UnitTypes::Terran_SCV) worker = unit;
			}
			for (unit_t* unit : ptr(player.st().player_units[6])) if (unit->unit_type->id == UnitTypes::Terran_Command_Center) base = unit;
			require(worker && base && player.st().current_minerals[0] == 75, "original Norad II workers, neutral base and opening minerals");
			functions.move_unit(worker, base->sprite->position + xy(48, 0));
			functions.set_unit_order(worker, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 1500; ++tick) player.next_frame();
			require(player.st().unit_counts[0][UnitTypes::Terran_Command_Center] == 1 && player.st().trigger_switches[10], "original base rescue activates both Zerg campaign scripts");
			for (int owner : {1, 4}) {
				require(player.st().campaign_ai[owner].upgrade_requests[(UpgradeTypes)26].first == 1, "both original Zerg scripts retain their requested upgrade level");
				require(player.st().upgrade_upgrading[owner][(UpgradeTypes)26] || functions.player_upgrade_level(owner, (UpgradeTypes)26) >= 1, "scripted Zerg upgrade starts or completes through native research");
			}
			printf("Norad II original base rescue passed.\n");
			std::array<bool, 2> fired{};
			for (int tick = 0; tick != 16000; ++tick) {
				for (int owner : {0, 2}) for (unit_t* unit : ptr(player.st().player_units[owner])) {
					functions.u_unset_status_flag(unit, unit_t::status_flag_invincible);
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
				}
				player.next_frame();
				for (int index = 0; index != 2; ++index) for (unit_id id : player.st().campaign_ai[index ? 4 : 1].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (unit && !functions.unit_dying(unit) && (unit->ground_weapon_cooldown || unit->air_weapon_cooldown)) fired[index] = true;
				}
				if (fired[0] && fired[1]) break;
			}
			require(fired[0] && fired[1], "both original Norad II Zerg scripts launch native attacking units that fire weapons");
			for (int owner : {1, 4}) require(functions.player_upgrade_level(owner, (UpgradeTypes)26) >= 1, "both original Zerg owners complete their scripted native upgrade");
			printf("Norad II original Zerg combat and upgrades passed.\n");
			norad_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (revolution) {
			player.st().strict_triggers = true;
			require(player.st().players[0].controller == player_t::controller_occupied, "Revolution preserves the original human slot zero");
			for (int tick = 0; tick != 32; ++tick) player.next_frame();
			require(!player.st().players[0].victory_state, "Revolution does not invent an opening outcome");
			printf("Revolution normal initialization passed.\n");
			state_functions functions(player.st());
			unit_t* kerrigan = nullptr;
			unit_t* marine = nullptr;
			for (int owner : {0, 2}) for (unit_t* unit : ptr(player.st().player_units[owner])) if (unit->unit_type->id == UnitTypes::Hero_Sarah_Kerrigan) kerrigan = unit;
			for (unit_t* unit : ptr(player.st().player_units[0])) {
				if (unit->unit_type->id == UnitTypes::Terran_Marine) marine = unit;
				functions.u_set_status_flag(unit, unit_t::status_flag_invincible);
			}
			require(kerrigan && marine && kerrigan->owner == 2, "original Revolution Kerrigan awaits separate proximity rescue");
			xy previous_position = marine->sprite->position;
			functions.move_unit(marine, kerrigan->sprite->position + xy(48, 0));
			kerrigan->main_order_timer = 0;
			functions.order_RescuePassive(kerrigan);
			require(kerrigan->owner == 0, "native proximity rescues the original Kerrigan actor");
			require(functions.unit_can_use_tech(kerrigan, functions.get_tech_type(TechTypes::Personnel_Cloaking)) && functions.unit_can_use_tech(kerrigan, functions.get_tech_type(TechTypes::Lockdown)), "original Kerrigan has native hero cloak and Lockdown eligibility without research grants");
			functions.move_unit(marine, previous_position);
			functions.u_set_status_flag(kerrigan, unit_t::status_flag_invincible);
			const auto& beacon = player.st().locations.at(0).area;
			functions.move_unit(kerrigan, (beacon.from + beacon.to) / 2);
			functions.set_unit_order(kerrigan, functions.get_order_type(Orders::HoldPosition));
			for (int tick = 0; tick != 4000 && !player.st().players[0].victory_state; ++tick) {
				for (unit_t* unit : ptr(player.st().player_units[6])) if (functions.ut_building(unit) && !functions.unit_dying(unit)) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
					functions.set_unit_hp(unit, unit->unit_type->hitpoints);
				}
				player.next_frame();
			}
			require(player.st().unit_counts[0][UnitTypes::Terran_Command_Center] == 1, "original Kerrigan beacon sequence rescues the neutral base through native rescue");
			printf("Revolution original base rescue passed.\n");
			activate_revolution_towns(player.st(), functions);
			const auto& ai = player.st().campaign_ai[6];
			require(ai.area_towns.size() == 1 && ai.build_requests[UnitTypes::Terran_SCV].first == 3 && ai.area_towns[0].build_requests[UnitTypes::Terran_SCV].first == 4, "Ter5 and Te5H retain independent main and satellite worker requests");
			int satellite_workers = 0;
			for (unit_t* unit : ptr(player.st().player_units[6])) if (unit->unit_type->id == UnitTypes::Terran_SCV && functions.campaign_ai_unit_town(6, unit) == 1 && functions.u_completed(unit)) ++satellite_workers;
			require(satellite_workers >= 4, "satellite town trains its fourth SCV through its own Command Center");
			require(functions.player_has_completed_unit(6, UnitTypes::Terran_Machine_Shop) && functions.player_has_completed_unit(6, UnitTypes::Terran_Control_Tower), "original Ter5 requests complete native Factory and Starport add-ons");
			unit_t* combat_target = nullptr;
			for (unit_t* unit : ptr(player.st().player_units[0])) {
				functions.u_unset_status_flag(unit, unit_t::status_flag_invincible);
				if (unit->unit_type->id == UnitTypes::Terran_Command_Center) combat_target = unit;
			}
			require(combat_target != nullptr, "original rescued base provides the native combat target");
			functions.u_unset_status_flag(combat_target, unit_t::status_flag_invincible);
			bool ground_attack = false;
			bool air_attack = false;
			bool weapon_fire = false;
			bool ground_weapon_fire = false;
			int maximum_party = 0;
			const int first_air_budget = 6000 + 4500 + 3000 + 6000 + 3000 + 5 * (500 + 180 * 15);
			for (int tick = 0; tick != first_air_budget; ++tick) {
				functions.set_unit_hp(combat_target, combat_target->unit_type->hitpoints);
				for (unit_t* unit : ptr(player.st().player_units[0])) {
					unit->defensive_matrix_hp = fp8::integer(64000);
					unit->defensive_matrix_timer = 250;
				}
				player.next_frame();
				maximum_party = std::max(maximum_party, int(player.st().campaign_ai[6].attack_party.size()));
				for (unit_id id : player.st().campaign_ai[6].attacking) {
					unit_t* unit = functions.get_unit(id);
					if (!unit || functions.unit_dying(unit)) continue;
					require(!functions.u_in_bunker(unit), "campaign waves do not recruit bunker occupants");
					if (functions.us_hidden(unit)) continue;
					if (functions.u_flying(unit)) {
						air_attack = true;
						if (unit->ground_weapon_cooldown || unit->air_weapon_cooldown) weapon_fire = true;
					}
					else if (functions.is_reachable(unit, combat_target)) {
						ground_attack = true;
						if (unit->ground_weapon_cooldown) ground_weapon_fire = true;
					}
				}
				if (ground_attack && air_attack && weapon_fire && ground_weapon_fire) break;
			}
			if (!ground_attack || !air_attack || !weapon_fire || !ground_weapon_fire) {
				const auto& current_ai = player.st().campaign_ai[6];
				printf("Revolution combat diagnostic: ground=%d air=%d fire=%d frame=%d outcome=%d preparing=%d launched=%d party=%d max_party=%d attacking=%d firebat_request=%d firebats=%d minerals=%d gas=%d alliance=%d target=%d,%d\n", ground_attack, air_attack, weapon_fire, player.st().current_frame, player.st().players[0].victory_state, current_ai.attack_preparing, current_ai.attack_launched, int(current_ai.attack_party.size()), maximum_party, int(current_ai.attacking.size()), current_ai.attack_requests[UnitTypes::Terran_Firebat], player.st().unit_counts[6][UnitTypes::Terran_Firebat], player.st().current_minerals[6], player.st().current_gas[6], player.st().alliances[6][0], combat_target->sprite->position.x, combat_target->sprite->position.y);
				for (const auto& script : player.st().campaign_ai_scripts) if (script.owner == 6) printf("Revolution script diagnostic: pc=%d wait=%d town=%d\n", int(script.position), script.wait, int(script.town));
				for (unit_t* unit : ptr(player.st().player_units[6])) if (unit->unit_type->id == UnitTypes::Terran_Firebat && !functions.us_hidden(unit)) printf("Revolution Firebat diagnostic: pos=%d,%d order=%d reachable=%d weapon=%d target=%d auto=%d\n", unit->sprite->position.x, unit->sprite->position.y, int(unit->order_type->id), functions.is_reachable(unit, combat_target), functions.unit_target_weapon(unit, combat_target) != nullptr, unit->order_target.unit != nullptr, unit->auto_target_unit != nullptr);
			}
			require(ground_attack && air_attack && weapon_fire && ground_weapon_fire, "original Ter5 schedule transports ground parties to the target island and fires native ground and air weapons");
			printf("Revolution original ground/air campaign attacks passed.\n");
			revolution_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (jacobs) {
			player.st().strict_triggers = true;
			require(player.st().players[0].controller == player_t::controller_occupied, "Jacobs Installation keeps its original human slot zero");
			player.next_frame();
			player.next_frame();
			require(!player.st().players[0].victory_state, "Jacobs Installation does not invent an opening outcome");
			state_functions functions(player.st());
			unit_t* door = nullptr;
			int disabled_traps = 0;
			for (int owner = 0; owner != 12; ++owner) for (unit_t* unit : ptr(player.st().player_units[owner])) {
				if (unit->unit_type->id == UnitTypes::Special_Upper_Level_Door) door = unit;
				if (functions.unit_is_trap(unit) && functions.u_disabled(unit)) ++disabled_traps;
			}
			require(door && disabled_traps == 2, "original installation doors and two disabled traps survive initialization");
			a_vector<unit_t*> marines;
			for (unit_t* unit : ptr(player.st().player_units[0])) if (unit->unit_type->id == UnitTypes::Terran_Marine) marines.push_back(unit);
			require(marines.size() >= 2, "original installation squad contains door and teleport test actors");
			require(functions.is_blocked(marines[0], door->sprite->position).second == door, "closed installation door blocks native unit collision checks");
			player.st().locations.emplace_back();
			player.st().locations.back().area = functions.square_at(door->sprite->position, 16);
			state_functions::execute_trigger_struct effects;
			running_trigger running;
			trigger::action action{};
			unit_t* raynor = nullptr;
			for (unit_t* unit : ptr(player.st().player_units[0])) if (unit->unit_type->id == UnitTypes::Hero_Jim_Raynor_Marine) raynor = unit;
			require(raynor != nullptr, "original Jacobs camera target is naturally rescued Raynor");
			auto anywhere = player.st().locations.at(63).area;
			action.type = 38;
			action.location = 64;
			action.group2_n = 30;
			action.extra_n = int(UnitTypes::Hero_Jim_Raynor_Marine);
			functions.execute_trigger_action(effects, 0, running, running.actions[0], action);
			const auto& camera_location = player.st().locations.at(29).area;
			require((camera_location.from + camera_location.to) / 2 == raynor->sprite->position, "original Zerg and disk Move Location fields center camera location 30 on Raynor");
			require(player.st().locations.at(63).area.from == anywhere.from && player.st().locations.at(63).area.to == anywhere.to, "moving the camera location must not move its Anywhere source");
			action = {};
			action.type = 42;
			action.group_n = 17;
			action.extra_n = int(door->unit_type->id);
			action.location = int(player.st().locations.size());
			functions.execute_trigger_action(effects, 0, running, running.actions[0], action);
			require(!functions.u_no_collide(door), "door opening waits for its animation signal before removing collision");
			for (int tick = 0; tick != 120; ++tick) player.next_frame();
			require(functions.u_status_flag(door, unit_t::status_flag_no_collide) && functions.u_disabled(door), "legacy original doodad action opens a door after its native animation");
			require(!functions.is_blocked(marines[0], door->sprite->position).first, "open door becomes passable to native collision and terrain checks");
			action.num_n = 4;
			functions.execute_trigger_action(effects, 0, running, running.actions[0], action);
			require(functions.u_no_collide(door), "door closing retains passage until its animation signal");
			for (int tick = 0; tick != 120; ++tick) player.next_frame();
			require(!functions.u_status_flag(door, unit_t::status_flag_no_collide) && !functions.u_disabled(door), "enabling a door closes it and restores collision");
			require(functions.is_blocked(marines[0], door->sprite->position).second == door, "closed door restores the physical blocker");
			const auto& source = player.st().locations.at(0).area;
			const auto& destination = player.st().locations.at(1).area;
			xy source_center = (source.from + source.to) / 2;
			xy destination_center = (destination.from + destination.to) / 2;
			functions.move_unit(marines[0], source_center + xy(16, 0));
			functions.move_unit(marines[1], source_center - xy(16, 0));
			action = {};
			action.type = 39;
			action.group_n = 13;
			action.extra_n = 230;
			action.location = 1;
			action.group2_n = 2;
			action.num_n = 1;
			functions.execute_trigger_action(effects, 0, running, running.actions[0], action);
			int moved = 0;
			for (size_t index = 0; index != 2; ++index) if (functions.xy_length(marines[index]->sprite->position - destination_center) < 128) ++moved;
			require(moved == 1, "teleport quantity one moves only one matching actor");
			action.num_n = 0;
			functions.execute_trigger_action(effects, 0, running, running.actions[0], action);
			for (size_t index = 0; index != 2; ++index) {
				if (functions.xy_length(marines[index]->sprite->position - destination_center) >= 128 || marines[index]->path) error("teleport actor %d at %d,%d path %d; source %d,%d-%d,%d destination %d,%d last error %d", int(index), marines[index]->sprite->position.x, marines[index]->sprite->position.y, int(marines[index]->path != nullptr), source.from.x, source.from.y, source.to.x, source.to.y, destination_center.x, destination_center.y, player.st().last_error);
			}
			printf("Jacobs Installation normal initialization passed.\n");
			jacobs_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (desperate) {
			player.st().strict_triggers = true;
			player.next_frame();
			player.next_frame();
			require(player.st().countdown_timer == 1800, "Desperate Alliance original countdown initialization");
			require(player.st().campaign_ai_scripts.size() == 1, "original computer-owned trigger starts Ter3");
			player.next_frame();
			player.next_frame();
			require(player.st().campaign_ai[4].campaign && !player.st().campaign_ai[4].town_active, "Ter3 campaign flag and initial frame wait");
			require(player.st().campaign_ai_scripts[0].position == 6878, "Ter3 wait resumes at audited start_town instruction");
			for (int tick = 0; tick != 20; ++tick) player.next_frame();
			const auto& ai = player.st().campaign_ai[4];
			require(ai.town_active && !ai.default_build && ai.maximum_force == 600, "original Ter3 town policies");
			require(ai.build_requests[UnitTypes::Zerg_Drone].first == 6 && ai.defenses.size() == 9, "original build target and defense request entries");
			int gathering = 0;
			for (unit_t* unit : ptr(player.st().player_units[4])) if (unit->unit_type->id == UnitTypes::Zerg_Drone && unit->order_type != unit->unit_type->human_ai_idle) ++gathering;
			require(gathering > 0, "campaign town assigns actual resource-gathering orders");
			state_functions functions(player.st());
			unit_t* worker = nullptr;
			for (unit_t* unit : ptr(player.st().player_units[4])) if (unit->unit_type->id == UnitTypes::Zerg_Drone) worker = unit;
			require(worker != nullptr, "original Drone replacement fixture");
			functions.kill_unit(worker);
			bool saw_drone_egg = false;
			for (int tick = 0; tick != 600; ++tick) {
				player.next_frame();
				for (unit_t* unit : ptr(player.st().player_units[4])) if (unit->unit_type->id == UnitTypes::Zerg_Egg && !unit->build_queue.empty() && unit->build_queue.front()->id == UnitTypes::Zerg_Drone) saw_drone_egg = true;
			}
			require(saw_drone_egg && player.st().completed_unit_counts[4][UnitTypes::Zerg_Drone] == 6, "script build target replaces a Drone through a normal timed egg");
			require(player.st().total_minerals_gathered[4] > 0, "computer economy gathers real minerals");
			bool launched = false;
			for (int tick = 0; tick != 4000 && !launched; ++tick) {
				player.next_frame();
				launched = !player.st().campaign_ai[4].attacking.empty();
			}
			require(launched, "original Ter3 first attack launches actual units");
			for (unit_id id : player.st().campaign_ai[4].attacking) require(functions.get_unit(id)->unit_type->id == UnitTypes::Zerg_Zergling, "original first wave contains Zerglings");
			unit_t* den = nullptr;
			for (unit_t* unit : ptr(player.st().player_units[4])) if (unit->unit_type->id == UnitTypes::Zerg_Hydralisk_Den) den = unit;
			require(den != nullptr, "original Hydralisk Den rebuilding fixture");
			unit_id den_id = functions.get_unit_id(den);
			functions.kill_unit(den);
			bool construction = false;
			bool rebuilt = false;
			for (int tick = 0; tick != functions.get_unit_type(UnitTypes::Zerg_Hydralisk_Den)->build_time + 2000 && !rebuilt; ++tick) {
				player.next_frame();
				for (unit_t* unit : ptr(player.st().player_units[4])) {
					if (functions.get_unit_id(unit) == den_id || unit->unit_type->id != UnitTypes::Zerg_Hydralisk_Den || functions.unit_dying(unit)) continue;
					if (functions.u_completed(unit)) rebuilt = true;
					else construction = true;
				}
			}
			if (!construction || !rebuilt) {
				for (unit_t* unit : ptr(player.st().player_units[4])) if (unit->unit_type->id == UnitTypes::Zerg_Drone) printf("Drone order=%d state=%d queued=%d\n", int(unit->order_type->id), unit->order_state, unit->build_queue.empty() ? -1 : int(unit->build_queue.front()->id));
				error("Den rebuild: construction=%d complete=%d allowed=%d minerals=%d gas=%d", int(construction), int(rebuilt), int(player.st().game->unit_type_allowed[4][UnitTypes::Zerg_Hydralisk_Den]), player.st().current_minerals[4], player.st().current_gas[4]);
			}
			printf("Desperate Alliance normal initialization passed.\n");
			desperate_mission_cases(load_data_file, map_file);
			return 0;
		}
		if (backwater) {
			backwater_checks(player.st());
			backwater_mission_cases(load_data_file, map_file);
			return 0;
		}
		expansion_availability_checks(load_data_file, map_file);
		campaign_checks(player.st());
		campaign_outcomes(load_data_file, map_file);
		return 0;
	}
	game_load.load_map(map_loader, [&]() {
		state& st = player.st();
		game_load.setup_info.victory_condition = 0;
		game_load.setup_info.tournament_mode = 0;
		game_load.setup_info.starting_units = 0;
		game_load.setup_info.resource_type = 1;
		game_load.setup_info.starting_minerals = 50;
		for (int i = 0; i != 12; ++i) {
			if (i == my_player) {
				st.players[i].controller = player_t::controller_occupied;
				st.players[i].race = my_race;
				game_load.setup_info.create_melee_units_for_player[i] = true;
			} else {
				st.players[i].controller = player_t::controller_inactive;
				game_load.setup_info.create_melee_units_for_player[i] = false;
			}
		}
	});

	state& st = player.st();
	printf("wasm sim: map '%s' %dx%d, units=%d, minerals=%d\n",
		st.game->scenario_name.c_str(), (int)st.game->map_width, (int)st.game->map_height,
		count_units(st, my_player), (int)st.current_minerals[my_player]);

	for (int i = 0; i != 500; ++i) player.next_frame();

	printf("wasm sim: after 500 frames: frame=%d units=%d minerals=%d\n",
		(int)st.current_frame, count_units(st, my_player), (int)st.current_minerals[my_player]);
	printf("wasm sim: OK\n");
	return 0;
}
