// Exports the game's item and building icons as small PNGs for the 3D build view:
//   <repo>/public/game-icons/items/<item id>.png      (ids from data/items.json)
//   <repo>/public/game-icons/buildings/<building id>.png (ids from data/building-footprints.json)
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
        var buildings = 0;
        foreach (var (row, fields) in buildingRows)
        {
            if (!buildingIds.TryGetValue(row, out var id)) continue;
            UTexture2D? tex = null;
            if (fields.TryGetValue(out FSoftObjectPath soft, "DisplayIcon") && !soft.AssetPathName.IsNone) soft.TryLoad(out tex);
            else fields.TryGetValue(out tex, "DisplayIcon");
            if (tex != null && Save(tex, Path.Combine(outDir, "buildings", $"{id}.png"))) buildings++;
        }

        var itemIds = JArray.Parse(File.ReadAllText(Path.Combine(data, "items.json"))).Select(i => (string)i["id"]!).ToHashSet();
        using var http = new HttpClient();
        var remote = JArray.Parse(await http.GetStringAsync(RemoteItems));
        var items = 0;
        var missing = new List<string>(itemIds);
        foreach (var item in remote)
        {
            var id = ((string?)item["name"])?.ToLowerInvariant();
            var icon = (string?)item["iconPath"]; // e.g. "/Ingredients/T_UI_PortalSigil"
            if (id == null || icon == null || !itemIds.Contains(id)) continue;
            var asset = $"AlchemyFactory/Content/Arts/UI{icon}.{icon[(icon.LastIndexOf('/') + 1)..]}";
            if (provider.TryLoadPackageObject<UTexture2D>(asset, out var tex) && Save(tex, Path.Combine(outDir, "items", $"{id}.png")))
            {
                items++;
                missing.Remove(id);
            }
        }

        Console.WriteLine($"Wrote {buildings} building icons and {items} item icons to {outDir}");
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
