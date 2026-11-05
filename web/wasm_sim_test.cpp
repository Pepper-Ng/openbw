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
		state_functions functions(st);
		for (int tick = 0; tick != 32; ++tick) functions.next_frame();
		require(st.current_minerals[0] == 300 && st.current_gas[0] == 300, "original Revolution trigger grants 300 minerals and gas");
		unit_t* kerrigan = nullptr;
		unit_t* raynor = nullptr;
		for (int owner : {0, 2}) for (unit_t* unit : ptr(st.player_units[owner])) {
			if (unit->unit_type->id == UnitTypes::Hero_Sarah_Kerrigan) kerrigan = unit;
			if (unit->unit_type->id == UnitTypes::Hero_Jim_Raynor_Vulture) raynor = unit;
		}
		require(kerrigan && raynor, "original Revolution hero actors");
		if (scenario == 6) {
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
			for (int tick = 0; tick != 4000; ++tick) functions.next_frame();
			require(st.unit_counts[0][UnitTypes::Terran_Command_Center] == 1, "original base rescue supplies the Wraith for satellite activation");
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

int main(int argc, char** argv) {
	const char* data_dir = argc > 1 ? argv[1] : "/data";
	const char* map_file = argc > 2 ? argv[2] : "/maps/Benzene.scx";
	int my_player = 0;
	race_t my_race = race_t::terran;
	bool campaign = argc > 3 && !strcmp(argv[3], "--test-campaign");
	bool backwater = campaign && argc > 4 && !strcmp(argv[4], "terran02");
	bool desperate = campaign && argc > 4 && !strcmp(argv[4], "terran03");
	bool jacobs = campaign && argc > 4 && !strcmp(argv[4], "terran04");
	bool revolution = campaign && argc > 4 && !strcmp(argv[4], "terran05");
	bool norad = campaign && argc > 4 && !strcmp(argv[4], "terran06");
	bool trump = campaign && argc > 4 && !strcmp(argv[4], "terran07");

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
			for (int tick = 0; tick != 4000 && !player.st().players[0].victory_state; ++tick) player.next_frame();
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
