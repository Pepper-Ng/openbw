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

int main(int argc, char** argv) {
	const char* data_dir = argc > 1 ? argv[1] : "/data";
	const char* map_file = argc > 2 ? argv[2] : "/maps/Benzene.scx";
	int my_player = 0;
	race_t my_race = race_t::terran;
	bool campaign = argc > 3 && !strcmp(argv[3], "--test-campaign");

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
