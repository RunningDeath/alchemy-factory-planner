// Exports the game's item and building icons as small PNGs for the 3D build view:
//   <repo>/public/game-icons/items/<item id>.png      (ids from data/items.json)
//   <repo>/public/game-icons/buildings/<building id>.png (ids from data/building-footprints.json)
//   <repo>/public/game-icons/manifest.json               ({ items, buildings }: the ids written)
// Building icons come from DT_Buildings.DisplayIcon. Items have no data table in the paks, so
// their icon paths come from the AlchemyFactoryData items.json (the same source scripts/sync-data.ts
// uses; its "name" lowercased is our item id). These are game assets: they're gitignored.
using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse_Conversion.Textures;
using Newtonsoft.Json.Linq;
using SkiaSharp;

static class Icons
{
    const int Size = 64;
    const string RemoteItems = "https://raw.githubusercontent.com/faultyd3v/AlchemyFactoryData/main/items.json";

    public static async Task<int> Export(DefaultFileProvider provider, Dictionary<string, FStructFallback> buildingRows, string repoRoot)
    {
        var outDir = Path.Combine(repoRoot, "public", "game-icons");
        var data = Path.Combine(repoRoot, "data");

        // building row name → our id (data/building-footprints.json carries both)
        var buildingIds = JArray.Parse(File.ReadAllText(Path.Combine(data, "building-footprints.json")))
            .ToDictionary(b => (string)b["row"]!, b => (string)b["id"]!, StringComparer.OrdinalIgnoreCase);
        var buildings = new List<string>();
        foreach (var (row, fields) in buildingRows)
        {
            if (!buildingIds.TryGetValue(row, out var id)) continue;
            // DisplayIcon is a soft reference in current builds; older ones held the texture directly
            var tex = fields.TryGetValue(out FSoftObjectPath soft, "DisplayIcon") && !soft.AssetPathName.IsNone && provider.TryLoadPackageObject<UTexture2D>(soft.AssetPathName.Text, out var loaded)
                ? loaded
                : fields.GetOrDefault<UTexture2D?>("DisplayIcon");
            if (tex != null && Save(tex, Path.Combine(outDir, "buildings", $"{id}.png"))) buildings.Add(id);
        }

        var itemIds = JArray.Parse(File.ReadAllText(Path.Combine(data, "items.json"))).Select(i => (string)i["id"]!).ToHashSet();
        using var http = new HttpClient();
        var remote = JArray.Parse(await http.GetStringAsync(RemoteItems));
        var items = new List<string>();
        var missing = new List<string>(itemIds);
        foreach (var item in remote)
        {
            var id = ((string?)item["name"])?.ToLowerInvariant();
            var icon = (string?)item["iconPath"]; // e.g. "/Ingredients/T_UI_PortalSigil"
            if (id == null || icon == null || !itemIds.Contains(id)) continue;
            var asset = $"AlchemyFactory/Content/Arts/UI{icon}.{icon[(icon.LastIndexOf('/') + 1)..]}";
            if (provider.TryLoadPackageObject<UTexture2D>(asset, out var tex) && Save(tex, Path.Combine(outDir, "items", $"{id}.png")))
            {
                items.Add(id);
                missing.Remove(id);
            }
        }

        // The app reads this first, so it only requests icons that exist
        File.WriteAllText(Path.Combine(outDir, "manifest.json"), new JObject { ["items"] = new JArray(items.Order()), ["buildings"] = new JArray(buildings.Order()) }.ToString());
        Console.WriteLine($"Wrote {buildings.Count} building icons and {items.Count} item icons to {outDir}");
        if (missing.Count > 0) Console.WriteLine($"No icon for items: {string.Join(", ", missing)}");
        return 0;
    }

    static bool Save(UTexture2D texture, string path)
    {
        using var bitmap = texture.Decode()?.ToSkBitmap();
        if (bitmap == null) return false;
        using var small = bitmap.Resize(new SKImageInfo(Size, Size, SKColorType.Rgba8888, SKAlphaType.Unpremul), SKFilterQuality.High);
        using var png = small.Encode(SKEncodedImageFormat.Png, 100);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, png.ToArray());
        return true;
    }
}
