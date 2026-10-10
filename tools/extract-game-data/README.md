# extract-game-data

Dumps the building table (`DT_Buildings`) from an Alchemy Factory install. The dump has footprints, belt/pipe ports, stacking flags and build costs, plus English names. `scripts/build-footprints.ts` turns it into `data/building-footprints.json`, which the build planner uses.

You only need this when the game updates. The generated JSON is committed.

## Requirements

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- A mappings file (`.usmap`) for the current game version. The game is UE 5.7 with unversioned properties, so assets can't be read without one.

### Getting a mappings file

1. Download the UE4SS experimental build: [RE-UE4SS releases](https://github.com/UE4SS-RE/RE-UE4SS/releases/tag/experimental-latest), `UE4SS_v3.0.1-*.zip`.
2. Extract `dwmapi.dll` and the `ue4ss` folder into `Alchemy Factory/AlchemyFactory/Binaries/Win64`.
3. Start the game. Once it has loaded, press `Ctrl+Numpad 6`. This writes `ue4ss/AlchemyFactory-<version>.usmap`.
4. Copy the `.usmap` somewhere else. Then delete `dwmapi.dll` and the `ue4ss` folder to remove UE4SS again.

## Run

```bash
cd tools/extract-game-data
dotnet run -c Release -- "<Steam>/steamapps/common/Alchemy Factory/AlchemyFactory/Content/Paks" path/to/mappings.usmap ../../dt_buildings.json
cd ../..
bun run build-footprints dt_buildings.json
```

The first run downloads the Oodle decompression library that CUE4Parse needs.
