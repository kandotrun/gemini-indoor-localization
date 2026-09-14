#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
	createGeminiMediaEmbedder,
	evaluateLocationQueries,
	locateMedia,
	parseLocationArgs,
} from "./index.mjs";

export const CLI_USAGE = `Usage:
  gemini-indoor-localize --manifest locations.json --query capture.jpg [options]
  gemini-indoor-localize --manifest locations.json --query-manifest holdouts.json [options]

Options:
  --reference-cache path  Reuse reference embeddings from a local JSON cache
  --top-k number           Number of candidates to return (default: 5)
  --min-score number       Minimum top score (default: 0.65)
  --min-margin number      Minimum top-two margin (default: 0.04)
  -h, --help               Show this help
`;

export async function main(args = process.argv.slice(2), env = process.env) {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(CLI_USAGE);
		return null;
	}
	const parsed = parseLocationArgs(args);
	const embedder = createGeminiMediaEmbedder({
		accessToken: env.GEMINI_ACCESS_TOKEN,
		apiKey: env.GEMINI_API_KEY,
		gateway: {
			accountId: env.AI_GATEWAY_ACCOUNT_ID,
			gatewayId: env.AI_GATEWAY_ID,
			token: env.AI_GATEWAY_TOKEN,
		},
		projectId: env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT,
	});
	const result = parsed.queryManifest
		? await evaluateLocationQueries({
				embedder,
				manifestPath: parsed.manifest,
				minMargin: parsed.minMargin,
				minScore: parsed.minScore,
				queryManifestPath: parsed.queryManifest,
				referenceCachePath: parsed.referenceCache,
				topK: parsed.topK,
			})
		: await locateMedia({
				embedder,
				manifestPath: parsed.manifest,
				minMargin: parsed.minMargin,
				minScore: parsed.minScore,
				queryPath: parsed.query,
				referenceCachePath: parsed.referenceCache,
				topK: parsed.topK,
			});
	console.log(JSON.stringify(result, null, 2));
	return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : "Unknown location inference failure.");
		process.exitCode = 1;
	});
}
