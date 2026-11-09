#pragma once

#include "bwgame.h"

namespace bwgame {

struct bunker_cliff_fixture {
	state& st;
	std::array<xy, 2> positions{};
	std::array<unit_id, 2> bunkers{};
	std::array<unit_id, 8> marines{};
	std::array<int, 8> first_shots{};
	std::array<int, 8> first_projectiles{};
	std::array<int, 2> death_frames{{-1, -1}};
	uint32_t seed;
	int start_frame = 0;
	bool finished = false;

	static void check(bool result, const char* description) {
		if (!result) error("bunker cliff fixture: %s", description);
	}

	explicit bunker_cliff_fixture(state& world, uint32_t random_seed = 1, bool reverse_creation = false) : st(world), seed(random_seed) {
		state_functions functions(st);
		check(st.game->triggers.empty(), "no mission or melee outcome triggers");
		for (int owner : {1, 4}) {
			st.players[owner].controller = player_t::controller_occupied;
			st.players[owner].race = race_t::terran;
			st.shared_vision[owner] = (1 << 1) | (1 << 4);
			st.game->tech_available[owner][TechTypes::Stim_Packs] = false;
			check(!st.upgrade_levels[owner][UpgradeTypes::Terran_Infantry_Weapons] && !st.upgrade_levels[owner][UpgradeTypes::Terran_Infantry_Armor] && !st.upgrade_levels[owner][UpgradeTypes::U_238_Shells], "equal unupgraded infantry");
		}
		st.alliances[1][4] = st.alliances[4][1] = 2;
		for (auto& tile : st.tiles) {
			tile.explored &= ~((1 << 1) | (1 << 4));
			tile.visible &= ~((1 << 1) | (1 << 4));
		}
		const auto* bunker_type = functions.get_unit_type(UnitTypes::Terran_Bunker);
		bool found = false;
		for (int vertical = 2; vertical < int(st.game->map_tile_height) - 3 && !found; ++vertical) for (int horizontal = 2; horizontal < int(st.game->map_tile_width) - 3 && !found; ++horizontal) {
			xy high = xy(horizontal * 32, vertical * 32) + bunker_type->placement_size / 2;
			if (!functions.can_place_building(nullptr, 1, bunker_type, high, false, false) || (st.tiles[functions.tile_index(high)].flags & tile_t::flag_provides_cover)) continue;
			for (int offset_y = -192; offset_y <= 192 && !found; offset_y += 32) for (int offset_x = -192; offset_x <= 192 && !found; offset_x += 32) {
				xy low = high + xy(offset_x, offset_y);
				if (!functions.is_in_map_bounds(low) || functions.xy_length(low - high) > 192) continue;
				if (std::abs(offset_x) < bunker_type->placement_size.x + 32 && std::abs(offset_y) < bunker_type->placement_size.y + 32) continue;
				if (functions.get_ground_height_at(high) <= functions.get_ground_height_at(low) || (st.tiles[functions.tile_index(low)].flags & tile_t::flag_provides_cover)) continue;
				if (!functions.can_place_building(nullptr, 4, bunker_type, low, false, false)) continue;
				positions = {{high, low}};
				found = true;
			}
		}
		check(found, "legal original-terrain cliff-top/base positions in mutual range without cover");
		std::array<unit_t*, 2> buildings{};
		for (int pass = 0; pass != 2; ++pass) {
			int side = reverse_creation ? 1 - pass : pass;
			int owner = side ? 4 : 1;
			buildings[side] = functions.trigger_create_unit(bunker_type, positions[side], owner);
			check(buildings[side] && buildings[side]->sprite->position == positions[side], "bunker uses its legal terrain position");
			bunkers[side] = functions.get_unit_id(buildings[side]);
			for (int index = 0; index != 4; ++index) {
				unit_t* marine = functions.trigger_create_unit(functions.get_unit_type(UnitTypes::Terran_Marine), xy(192, 96), owner);
				check(marine && functions.unit_can_load_target(buildings[side], marine), "native bunker accepts each of four Marines");
				functions.unit_load_target(buildings[side], marine);
				functions.set_unit_order(marine, functions.get_order_type(Orders::Nothing));
				marines[side * 4 + index] = functions.get_unit_id(marine);
			}
			check(range_size(functions.loaded_units(buildings[side])) == 4, "exactly four Marines are loaded");
		}
		for (int tick = 0; tick != 64; ++tick) functions.next_frame();
		check(buildings[0]->hp == bunker_type->hitpoints && buildings[1]->hp == bunker_type->hitpoints, "equal full bunker HP after visibility preparation");
		check(functions.unit_target_miss_chance(functions.get_unit(marines[0]), buildings[1]) == 0_fp8 && functions.unit_target_miss_chance(functions.get_unit(marines[4]), buildings[0]) == 119_fp8, "normal downhill and original uphill miss thresholds");
		st.alliances[1][4] = st.alliances[4][1] = 0;
		st.lcg_rand_state = seed;
		for (int index = 0; index != 8; ++index) {
			unit_t* marine = functions.get_unit(marines[index]);
			unit_t* target = buildings[index < 4 ? 1 : 0];
			check(functions.unit_can_see_target(marine, target), "both sides have spotting before the synchronized first shot");
			functions.set_unit_heading(marine, functions.xy_direction(target->sprite->position - marine->sprite->position));
			functions.set_unit_order(marine, functions.get_order_type(Orders::BunkerGuard), target);
			marine->main_order_timer = 0;
			marine->order_process_timer = 0;
			marine->ground_weapon_cooldown = 0;
		}
		first_shots.fill(-1);
		first_projectiles.fill(-1);
		start_frame = st.current_frame;
	}

	void step() {
		state_functions functions(st);
		functions.next_frame();
		int elapsed = st.current_frame - start_frame;
		for (int index = 0; index != 8; ++index) {
			unit_t* marine = functions.get_unit(marines[index]);
			if (first_shots[index] < 0 && marine && marine->ground_weapon_cooldown) first_shots[index] = elapsed;
			if (elapsed == 1) check(first_shots[index] == 1, "all eight Marines fire on exactly the first simulation frame");
		}
		for (bullet_t* bullet : ptr(st.active_bullets)) {
			if (!bullet->bullet_owner_unit) continue;
			for (int index = 0; index != 8; ++index) if (first_projectiles[index] < 0 && functions.get_unit(marines[index]) == bullet->bullet_owner_unit) first_projectiles[index] = elapsed;
		}
		for (int side = 0; side != 2; ++side) {
			unit_t* bunker = functions.get_unit(bunkers[side]);
			if (death_frames[side] < 0 && (!bunker || functions.unit_dying(bunker))) death_frames[side] = elapsed;
		}
		bool eliminated = (death_frames[0] >= 0 && !st.unit_counts[1][UnitTypes::Terran_Marine]) || (death_frames[1] >= 0 && !st.unit_counts[4][UnitTypes::Terran_Marine]);
		finished = finished || (eliminated && st.active_bullets.empty());
		if (finished) for (int first : first_projectiles) check(first > 0 && first == first_projectiles[0], "all eight first projectiles launch on the same simulation frame");
		check(finished || elapsed <= 1920, "duel terminates within its observation bound");
	}

	int hitpoints(int side) const {
		state_functions functions(st);
		unit_t* bunker = functions.get_unit(bunkers[side]);
		return bunker && !functions.unit_dying(bunker) ? bunker->hp.integer_part() : 0;
	}

	a_string snapshot() const {
		state_functions functions(st);
		return format("%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%u\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\n", st.current_frame - start_frame, hitpoints(0), hitpoints(1), death_frames[0], death_frames[1], st.unit_counts[1][UnitTypes::Terran_Marine], st.unit_counts[4][UnitTypes::Terran_Marine], first_shots[0], seed, positions[0].x, positions[0].y, positions[1].x, positions[1].y, functions.get_ground_height_at(positions[0]), functions.get_ground_height_at(positions[1]), functions.get_unit_type(UnitTypes::Terran_Bunker)->hitpoints.integer_part(), finished, first_projectiles[0]);
	}
};

}