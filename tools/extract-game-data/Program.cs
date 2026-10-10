// Dumps DT_Buildings (footprints, ports, costs) from an Alchemy Factory install as JSON,
// with English display names. scripts/build-footprints.ts turns the dump into
// data/building-footprints.json.
//
// Usage: dotnet run -- <paks dir> <mappings.usmap> <out.json>
// The game uses unversioned properties, so a .usmap is required (see README.md).
using CUE4Parse.Compression;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Assets.Exports.Engine;
using CUE4Parse.UE4.Localization;
using CUE4Parse.UE4.Versions;
using Newtonsoft.Json;

if (args.Length < 3)
{
    Console.Error.WriteLine("Usage: dotnet run -- <paks dir> <mappings.usmap> <out.json>");
    return 1;
}
var (paksDir, usmapPath, outPath) = (args[0], args[1], args[2]);

var oodlePath = Path.Combine(AppContext.BaseDirectory, "oo2core_9_win64.dll");
if (!File.Exists(oodlePath))
{
    var downloaded = oodlePath;
    OodleHelper.DownloadOodleDll(ref downloaded);
    oodlePath = downloaded;
}
OodleHelper.Initialize(oodlePath);

var provider = new DefaultFileProvider(paksDir, SearchOption.TopDirectoryOnly, new VersionContainer(EGame.GAME_UE5_7), StringComparer.OrdinalIgnoreCase)
{
    MappingsContainer = new FileUsmapTypeMappingsProvider(usmapPath, StringComparer.OrdinalIgnoreCase),
};
provider.Initialize();
provider.Mount();

var table = provider.LoadPackageObject<UDataTable>("AlchemyFactory/Content/DataTables/DT_Buildings.DT_Buildings");
var rows = table.RowMap.ToDictionary(kv => kv.Key.Text, kv => kv.Value);

// English strings, keyed by localization key (DisplayName.Key in the rows)
var locres = new FTextLocalizationResource(provider.CreateReader("AlchemyFactory/Content/Localization/Game/en/Game.locres"));
var english = new Dictionary<string, string>();
foreach (var ns in locres.Entries)
    foreach (var entry in ns.Value)
        english.TryAdd(entry.Key.Str, entry.Value.LocalizedString);

File.WriteAllText(outPath, JsonConvert.SerializeObject(new { buildings = rows, english }, Formatting.Indented));
Console.WriteLine($"Wrote {rows.Count} buildings to {outPath}");
return 0;
