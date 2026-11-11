#include "data_loading.h"
#include <algorithm>
#include <set>

using namespace bwgame;
using namespace bwgame::data_loading;

struct embedded_mpq_reader {
	file_reader<> file;
	size_t base = 0;
	size_t length = 0;
	size_t position = 0;

	explicit embedded_mpq_reader(a_string filename) : file(std::move(filename)) {
		length = file.size();
		auto prefix = file.get_vec<uint8_t>(std::min(length, size_t(1024 * 1024)));
		bool found = false;
		for (size_t offset = 0; offset + 32 <= prefix.size(); offset += 512) {
			const uint8_t* header = prefix.data() + offset;
			if (value_at<uint32_t, true>(header) != 0x1a51504d) continue;
			if (value_at<uint32_t, true>(header + 4) != 32 || value_at<uint16_t, true>(header + 12) != 0) continue;
			size_t archive_size = value_at<uint32_t, true>(header + 8);
			if (archive_size < 32 || archive_size > length - offset) error("invalid embedded MPQ size");
			if (value_at<uint16_t, true>(header + 14) > 8) error("invalid MPQ sector size");
			for (size_t table = 0; table != 2; ++table) {
				size_t table_offset = value_at<uint32_t, true>(header + 16 + table * 4);
				size_t entries = value_at<uint32_t, true>(header + 24 + table * 4);
				if (!entries || entries > 65536 || table_offset < 32 || table_offset > archive_size || entries > (archive_size - table_offset) / 16) error("invalid MPQ table bounds");
				if (!table && (entries & (entries - 1))) error("MPQ hash table size is not a power of two");
			}
			base = offset;
			length = archive_size;
			found = true;
			break;
		}
		if (!found) error("no MPQ v0 header in the first MiB");
		seek(0);
	}

	void seek(size_t offset) {
		if (offset > length) error("embedded MPQ seek out of bounds");
		position = offset;
		file.seek(base + offset);
	}
	void get_bytes(uint8_t* destination, size_t count) {
		if (count > length - position) error("embedded MPQ read out of bounds");
		if (count) file.get_bytes(destination, count);
		position += count;
	}
	size_t size() const { return length; }
};

static a_string normalize_path(a_string path) {
	if (path.empty() || path.size() > 240) error("invalid mission path length");
	size_t component = 0;
	for (size_t index = 0; index <= path.size(); ++index) {
		if (index < path.size()) {
			unsigned char character = path[index];
			if (character < 32 || character >= 127 || character == ':' || character == '"' || character == '*' || character == '?' || character == '<' || character == '>' || character == '|') error("invalid mission path character");
			if (character == '/') path[index] = '\\';
			if (character >= 'A' && character <= 'Z') path[index] += 'a' - 'A';
		}
		if (index == path.size() || path[index] == '\\') {
			auto part = path.substr(component, index - component);
			if (part.empty() || part == "." || part == ".." || part.back() == '.' || part.back() == ' ') error("invalid mission path component");
			component = index + 1;
		}
	}
	return path;
}

struct mission_file {
	a_string path;
	a_vector<uint8_t> bytes;
};

static a_vector<uint8_t> make_pack(const a_vector<mission_file>& files) {
	auto crypt = get_crypt_table();
	size_t slots = 1;
	while (slots < files.size() * 2) slots *= 2;
	a_vector<uint8_t> hashes(slots * 16, 0xff);
	a_vector<uint8_t> blocks(files.size() * 16);
	a_vector<uint8_t> result(32, 0);
	for (size_t index = 0; index != files.size(); ++index) {
		const auto& file = files[index];
		if (file.bytes.size() > 16 * 1024 * 1024 || result.size() + file.bytes.size() > 32 * 1024 * 1024) error("mission pack size limit exceeded");
		size_t slot = string_hash(file.path.c_str(), 0, crypt) % slots;
		while (value_at<uint32_t, true>(hashes.data() + slot * 16 + 12) != 0xffffffff) slot = (slot + 1) % slots;
		uint8_t* hash = hashes.data() + slot * 16;
		set_value_at<true>(hash, string_hash(file.path.c_str(), 1, crypt));
		set_value_at<true>(hash + 4, string_hash(file.path.c_str(), 2, crypt));
		set_value_at<true>(hash + 8, uint32_t(0));
		set_value_at<true>(hash + 12, uint32_t(index));
		uint8_t* block = blocks.data() + index * 16;
		set_value_at<true>(block, uint32_t(result.size()));
		set_value_at<true>(block + 4, uint32_t(file.bytes.size()));
		set_value_at<true>(block + 8, uint32_t(file.bytes.size()));
		set_value_at<true>(block + 12, uint32_t(0x80000000));
		result.insert(result.end(), file.bytes.begin(), file.bytes.end());
	}
	auto append_table = [&](a_vector<uint8_t> table, const char* name) {
		uint32_t key = string_hash(name, 3, crypt);
		uint32_t seed = 0xeeeeeeee;
		for (size_t offset = 0; offset != table.size(); offset += 4) {
			uint32_t plain = value_at<uint32_t, true>(table.data() + offset);
			seed += crypt[1024 + (key & 0xff)];
			set_value_at<true>(table.data() + offset, plain ^ (key + seed));
			seed = seed * 33 + plain + 3;
			key = ((~key << 21) + 0x11111111) | (key >> 11);
		}
		uint32_t offset = uint32_t(result.size());
		result.insert(result.end(), table.begin(), table.end());
		return offset;
	};
	uint32_t hash_offset = append_table(std::move(hashes), "(hash table)");
	uint32_t block_offset = append_table(std::move(blocks), "(block table)");
	set_value_at<true>(result.data(), uint32_t(0x1a51504d));
	set_value_at<true>(result.data() + 4, uint32_t(32));
	set_value_at<true>(result.data() + 8, uint32_t(result.size()));
	set_value_at<true>(result.data() + 14, uint16_t(3));
	set_value_at<true>(result.data() + 16, hash_offset);
	set_value_at<true>(result.data() + 20, block_offset);
	set_value_at<true>(result.data() + 24, uint32_t(slots));
	set_value_at<true>(result.data() + 28, uint32_t(files.size()));
	mpq_data round_trip(result.data(), result.size());
	for (const auto& file : files) {
		a_vector<uint8_t> actual;
		round_trip(actual, file.path);
		if (actual != file.bytes) error("mission pack round-trip mismatch: %s", file.path);
	}
	return result;
}

static void write_output(const char* path, const a_vector<uint8_t>& bytes) {
	FILE* output = fopen(path, "wb");
	if (!output) error("cannot open preparation output");
	bool written = fwrite(bytes.data(), 1, bytes.size(), output) == bytes.size();
	if (fclose(output) || !written) error("cannot write preparation output");
}

int main(int argc, char** argv) {
	if (argc != 4) error("usage: campaign-pack SOURCE MISSION OUTPUT");
	a_string mission = argv[2];
	bool expansion_terran = mission == "bwterran01" || mission == "bwterran02" || mission == "bwterran03" || mission == "bwterran04" || mission == "bwterran05a" || mission == "bwterran05b" || mission == "bwterran06" || mission == "bwterran07" || mission == "bwterran08";
	bool expansion_zerg = mission == "bwzerg01" || mission == "bwzerg02" || mission == "bwzerg03" || mission == "bwzerg04a" || mission == "bwzerg04b" || mission == "bwzerg04c" || mission == "bwzerg04d" || mission == "bwzerg04e" || mission == "bwzerg04f" || mission == "bwzerg05" || mission == "bwzerg06" || mission == "bwzerg07";
	bool expansion = expansion_terran || expansion_zerg || mission == "bwprotoss01" || mission == "bwprotoss02" || mission == "bwprotoss03" || mission == "bwprotoss04" || mission == "bwprotoss05" || mission == "bwprotoss06" || mission == "bwprotoss07" || mission == "bwprotoss08";
	if (!expansion && mission != "terran01" && mission != "terran02" && mission != "terran03" && mission != "terran04" && mission != "terran05" && mission != "terran06" && mission != "terran08" && mission != "terran09" && mission != "terran11" && mission != "terran12" && mission != "zerg01" && mission != "zerg02" && mission != "zerg03" && mission != "zerg04" && mission != "zerg05" && mission != "zerg06" && mission != "zerg07" && mission != "zerg08" && mission != "zerg09" && mission != "zerg10" && mission != "protoss01" && mission != "protoss02" && mission != "protoss03" && mission != "protoss04" && mission != "protoss05" && mission != "protoss06" && mission != "protoss07" && mission != "protoss08" && mission != "protoss09" && mission != "protoss10" && mission != "--ai-script" && mission != "--bw-script") error("unsupported preparation request");
	a_string mission_root = expansion ? "campaign\\" + a_string(expansion_terran ? "expterran" : expansion_zerg ? "expzerg" : "expprotoss") + "\\" + mission.substr(2) + "\\" : "campaign\\" + a_string(mission.compare(0, 7, "protoss") == 0 ? "protoss" : mission.compare(0, 4, "zerg") == 0 ? "zerg" : "terran") + "\\" + mission + "\\";
	embedded_mpq_reader source(argv[1]);
	paged_reader<embedded_mpq_reader> reader(source);
	auto archive = make_mpq_archive_reader(reader);
	for (const auto& block : archive.block_table) {
		if (!(block.flags & 0x80000000)) continue;
		if (block.data_offset > source.size() || block.compressed_size > source.size() - block.data_offset) error("MPQ block out of bounds");
	}
	auto extract = [&](const a_string& path) {
		a_string resolved = path;
		if (!archive.file_exists(resolved)) resolved = mission_root + path;
		auto entry = archive.open(resolved);
		if (entry.size() > 16 * 1024 * 1024) error("mission dependency size limit exceeded");
		a_vector<uint8_t> bytes(entry.size());
		if (!bytes.empty()) entry.get_bytes(bytes.data(), bytes.size());
		return bytes;
	};
	if (mission == "--ai-script" || mission == "--bw-script") {
		auto bytes = extract(mission == "--bw-script" ? "scripts\\bwscript.bin" : "scripts\\aiscript.bin");
		write_output(argv[3], bytes);
		printf("Extracted %zu AI-script bytes\n", bytes.size());
		return 0;
	}
	auto scenario = extract(mission_root + "staredit\\scenario.chk");
	a_vector<mission_file> files;
	files.push_back({"staredit\\scenario.chk", scenario});
	a_vector<uint8_t> strings;
	a_vector<uint32_t> sounds;
	data_reader<> chunks(scenario.data(), scenario.data() + scenario.size());
	while (chunks.left()) {
		auto name = chunks.get<uint32_t>();
		auto length = chunks.get<uint32_t>();
		const uint8_t* chunk = chunks.get_n(length);
		if (name == 0x20525453) strings.assign(chunk, chunk + length);
		if (name == 0x20564157) {
			if (length % 4) error("invalid WAV section length");
			data_reader<> entries(chunk, chunk + length);
			while (entries.left()) sounds.push_back(entries.get<uint32_t>());
		}
	}
	data_reader<> table(strings.data(), strings.data() + strings.size());
	auto count = table.get<uint16_t>();
	std::set<a_string> paths;
	for (uint32_t index : sounds) {
		if (!index) continue;
		if (index > count) error("WAV string index out of bounds");
		table.seek(2 + (index - 1) * 2);
		size_t offset = table.get<uint16_t>();
		if (offset >= strings.size()) error("WAV string offset out of bounds");
		a_string path;
		while (offset < strings.size() && strings[offset]) path += char(strings[offset++]);
		if (offset == strings.size()) error("unterminated WAV path");
		paths.insert(normalize_path(std::move(path)));
	}
	for (const auto& path : paths) {
		auto sound = extract(path);
		if (sound.size() < 12 || value_at<uint32_t, true>(sound.data()) != 0x46464952 || value_at<uint32_t, true>(sound.data() + 8) != 0x45564157) error("invalid WAV: %s", path);
		files.push_back({path, std::move(sound)});
	}
	auto pack = make_pack(files);
	write_output(argv[3], pack);
	printf("Round-trip verified %zu files; pack size %zu bytes\n", files.size(), pack.size());
	return 0;
}