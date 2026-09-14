# Gemini Indoor Localization

Reference-based indoor visual localization with [Gemini Embedding 2](https://ai.google.dev/gemini-api/docs/embeddings).

This project turns a set of labeled reference photos or videos into a searchable location map. A query photo or short video is embedded with the same model, compared with cosine similarity, and mapped to the nearest reference location. The model does not predict coordinates by itself: `floor`, `x`, and `y` come from the metadata in your reference manifest.

> **Status:** experimental OSS release (`0.1.0`). Validate accuracy with held-out captures from your own building before relying on the result for navigation or safety decisions.

## What it does

- Embeds JPEG, PNG, MP4, and MOV files with `gemini-embedding-2`.
- Supports a Gemini API key, Vertex AI Application Default Credentials (ADC), or Cloudflare AI Gateway.
- Ranks reference locations with cosine similarity.
- Returns `matched`, `ambiguous`, or `no_match` instead of hiding uncertainty.
- Estimates a coordinate on the winning floor using score-weighted reference coordinates.
- Caches reference embeddings by model, dimensions, file size, and SHA-256 fingerprint.
- Evaluates a holdout manifest with top-1, top-k, and floor accuracy.
- Keeps unknown holdouts and provider failures explicit in evaluation output.

The package uses only Node.js built-ins. There are no runtime dependencies.

## Requirements

- Node.js 22 or newer
- Access to Gemini Embedding 2 through one of the authentication paths below
- Reference media in JPEG, PNG, MP4, or MOV format

Clone the repository and run the checks without installing runtime dependencies:

```bash
git clone https://github.com/kandotrun/gemini-indoor-localization.git
cd gemini-indoor-localization
npm test
```

## Authentication

Copy the environment template and choose one path:

```bash
cp .env.example .env
```

For a direct Gemini API key:

```bash
export GEMINI_API_KEY="..."
```

For Vertex AI ADC:

```bash
export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
gcloud auth application-default login
```

The CLI obtains a short-lived token with `gcloud auth application-default print-access-token`. An API key and ADC cannot be used together. Cloudflare AI Gateway uses the Gemini API key path and requires all three `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID`, and `AI_GATEWAY_TOKEN` variables.

## Reference manifest

A manifest is a JSON array or JSONL file. `file` is relative to the manifest file. Coordinates use a coordinate system that you define for your building; this example uses meters from an arbitrary floor-plan origin.

```json
[
  {
    "id": "lobby-entrance",
    "label": "Lobby entrance",
    "file": "reference/lobby-entrance.jpg",
    "location": { "floor": "1F", "x": 12.4, "y": 8.1 }
  },
  {
    "id": "meeting-room",
    "label": "Meeting room",
    "file": "reference/meeting-room.jpg",
    "location": { "floor": "2F", "x": 41.0, "y": 22.0 }
  }
]
```

Each reference needs a unique `id`, a media `file`, and a `location` with a string `floor` plus finite numeric `x` and `y`. An optional `z` coordinate and explicit `mimeType` are supported. See [`examples/location-manifest.json`](examples/location-manifest.json).

## Locate one photo or video

```bash
node src/cli.mjs \
  --manifest ./examples/location-manifest.json \
  --query ./captures/now.jpg \
  --reference-cache ./.cache/references.json \
  --top-k 5 \
  --min-score 0.65 \
  --min-margin 0.04
```

The command prints JSON containing the ranked candidates, their similarity scores, evidence for the decision, and an estimate when the result is `matched`.

Supported query media:

- `image/jpeg`
- `image/png`
- `video/mp4`
- `video/quicktime` (MOV)

The media is sent inline to Gemini. Keep videos short and within the provider's request limits; a 5-second clip is a practical starting point. iPhone HEIC files must be converted to JPEG first.

## Evaluate held-out captures

Create a query manifest with one row per test capture:

```json
[
  {
    "id": "holdout-001",
    "file": "captures/lobby-001.jpg",
    "expectedReferenceId": "lobby-entrance"
  },
  {
    "id": "unknown-001",
    "file": "captures/outside.jpg",
    "expectedReferenceId": null
  }
]
```

Then run:

```bash
node src/cli.mjs \
  --manifest ./examples/location-manifest.json \
  --query-manifest ./examples/holdouts.json \
  --reference-cache ./.cache/references.json \
  --top-k 5
```

The report includes:

- `top1Accuracy`: the nearest reference is correct.
- `topKAccuracy`: the expected reference appears in the returned candidates.
- `floorTop1Accuracy`: the nearest reference is on the expected floor.
- `statusCounts`: counts for `matched`, `ambiguous`, `no_match`, and `error`.
- `groundTruthAvailable: false` for unknown captures, which are retained but excluded from accuracy when all queries complete.

If any provider call for a reference fails, the report marks the evaluation incomplete and keeps the failures visible. It does not silently calculate accuracy from a reduced reference set.

## JavaScript API

The package exposes the same operations used by the CLI:

```js
import {
  createGeminiMediaEmbedder,
  evaluateLocationQueries,
  locateMedia,
  rankLocationCandidates,
} from "./src/index.mjs";

const embedder = createGeminiMediaEmbedder({
  apiKey: process.env.GEMINI_API_KEY,
});

const result = await locateMedia({
  embedder,
  manifestPath: "./location-manifest.json",
  queryPath: "./captures/now.jpg",
  referenceCachePath: "./.cache/references.json",
  topK: 5,
  minScore: 0.65,
  minMargin: 0.04,
});

console.log(result.status, result.candidates[0], result.estimate);
```

When installed from npm, replace the relative import with `gemini-indoor-localization`.

For applications that already have vectors, call `rankLocationCandidates(queryEmbedding, references, options)` directly. Each reference must contain an `embedding` array and the manifest location fields.

## Choosing thresholds

`min-score` controls whether a query resembles any registered reference. `min-margin` controls how much the top candidate must exceed the second candidate before the result is considered reliable. The defaults (`0.65` and `0.04`) are starting points, not guarantees.

Collect separate reference and holdout media for every location. Vary time, angle, height, and lighting. Tune thresholds against held-out captures and report both accuracy and the rate of `ambiguous` / `no_match` results. Similar corridors, repeated interior design, floor changes, and moved furniture can make a visual-only result uncertain. Combining floor constraints, beacons, or phone sensors is recommended for production navigation.

## Privacy and data handling

This repository contains no building media or embeddings. The CLI reads local files, sends the selected reference/query media to the configured Gemini endpoint, and writes an optional local cache. Review Google's retention terms and your organization's data policy before sending workplace or customer imagery. Do not commit API keys, caches, reference media, or evaluation captures.

## Development

```bash
npm test
npm run check
```

The test suite uses stub embedders and does not call Gemini. Pull requests run the same checks in GitHub Actions. Contributions should include focused tests for behavior changes and keep provider credentials out of fixtures and logs. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## 日本語

Gemini Embedding 2で参照写真・動画と撮影画像・短い動画を比較し、近い参照地点の`floor / x / y`を返す屋内位置推定ライブラリです。座標をモデルが直接予測するのではなく、参照マニフェストのメタデータを使います。

このリポジトリは実験段階のOSSです。建物ごとに参照データとholdoutデータを分けて精度を検証し、`ambiguous`や`no_match`を含めて運用可否を判断してください。APIキー、建物の写真、Embeddingキャッシュはコミットしないでください。

## License

[MIT](LICENSE)
