// web/wasm_sim_test.cpp — WebAssembly sim bring-up test.
//
// Proves the OpenBW *simulation* compiles and runs under WebAssembly (WASI),
// with no UI/SDL at all. Run with a WASI host (Node's node:wasi) that preopens
// the game data + map directories. This de-risks the whole browser port before
// any canvas/JS backend exists.

#include "bwgame.h"
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

static void campaign_checks(state& st) {
	struct observed_functions : state_functions {
		using state_functions::state_functions;
		a_vector<int> events;
		void on_trigger_action(int, const trigger::action& action) override { events.push_back(action.type); }
	} functions(st);
	require(count_units(st, 1) == 12 && count_units(st, 2) == 1 && count_units(st, 4) == 23 && count_units(st, 11) == 10, "original 46 actors");
	for (UnitTypes type : {UnitTypes::Terran_Marine, UnitTypes::Terran_SCV, UnitTypes::Terran_Command_Center, UnitTypes::Terran_Supply_Depot, UnitTypes::Terran_Barracks}) require(st.game->unit_type_allowed[1][type], "original mission unit availability");
	for (UnitTypes type : {UnitTypes::Terran_Ghost, UnitTypes::Terran_Factory, UnitTypes::Terran_Starport}) require(!st.game->unit_type_allowed[1][type], "original mission unit restrictions");
	require(!functions.player_tech_available(1, TechTypes::Stim_Packs), "original mission tech restrictions");
	unit_t* marine = nullptr;
	unit_t* raynor = nullptr;
	for (unit_t* unit : ptr(st.player_units[1])) if (unit->unit_type->id == UnitTypes::Terran_Marine) marine = unit;
	for (unit_t* unit : ptr(st.player_units[2])) raynor = unit;
	require(marine && raynor, "human Marine and rescue Raynor");
	xy original = marine->sprite->position;
	functions.move_unit(marine, raynor->sprite->position + xy(96, 0));
	functions.order_RescuePassive(raynor);
	require(raynor->owner == 2, "out-of-range unit must not rescue");
	functions.move_unit(marine, raynor->sprite->position + xy(48, 0));
	raynor->main_order_timer = 0;
	functions.order_RescuePassive(raynor);
	require(raynor->owner == 1 && raynor->order_type->id != Orders::RescuePassive, "proximity transfers ownership and restores human idle order");
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
	action.location = int(destination + 1);
	action.group2_n = int(search + 1);
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
			for (int member = 0; member != 2; ++member) {
				functions.move_unit(zerglings[member], old_target->sprite->position);
				functions.set_unit_order(zerglings[member], functions.get_order_type(Orders::PlayerGuard));
				zerglings[member]->auto_target_unit = nullptr;
			}
			st.current_frame = (st.current_frame + 7) / 8 * 8;
			functions.progress_campaign_ai_town(4);
			unit_t* target = functions.get_unit(ai.military_target);
			require(target && target != old_target && !functions.unit_dying(target), "military chooses a new live target after a cleared destination");
			for (int member = 0; member != 2; ++member) require(zerglings[member]->order_type->id == Orders::AttackMove && zerglings[member]->order_target.pos == target->sprite->position, "surviving idle attackers continue together rather than parking at the old destination");
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

int main(int argc, char** argv) {
	const char* data_dir = argc > 1 ? argv[1] : "/data";
	const char* map_file = argc > 2 ? argv[2] : "/maps/Benzene.scx";
	int my_player = 0;
	race_t my_race = race_t::terran;
	bool campaign = argc > 3 && !strcmp(argv[3], "--test-campaign");
	bool backwater = campaign && argc > 4 && !strcmp(argv[4], "terran02");
	bool desperate = campaign && argc > 4 && !strcmp(argv[4], "terran03");

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
