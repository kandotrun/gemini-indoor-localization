import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	cosineSimilarity,
	createGeminiMediaEmbedder,
	evaluateLocationQueries,
	inferMediaMimeType,
	LOCATION_EMBEDDING_DIMENSIONS,
	LOCATION_EMBEDDING_MODEL,
	LocationEmbeddingError,
	LocationInputError,
	loadLocationManifest,
	loadLocationQueryManifest,
	parseLocationManifest,
	parseLocationArgs,
	parseLocationQueryManifest,
	rankLocationCandidates,
	requestGeminiMediaEmbedding,
} from "../src/index.mjs";

test("parses CLI options and requires a manifest and query", () => {
	assert.deepEqual(
		parseLocationArgs([
			"--manifest",
			"locations.json",
			"--query",
			"query.jpg",
			"--top-k",
			"3",
			"--min-score",
			"0.7",
			"--min-margin",
			"0.08",
		]),
		{
			manifest: "locations.json",
			minMargin: 0.08,
			minScore: 0.7,
			query: "query.jpg",
			queryManifest: undefined,
			referenceCache: undefined,
			topK: 3,
		},
	);
	assert.deepEqual(
		parseLocationArgs([
			"--manifest",
			"locations.json",
			"--query-manifest",
			"holdout.jsonl",
			"--reference-cache",
			"cache.json",
		]),
		{
			manifest: "locations.json",
			minMargin: 0.04,
			minScore: 0.65,
			query: undefined,
			queryManifest: "holdout.jsonl",
			referenceCache: "cache.json",
			topK: 5,
		},
	);
	assert.throws(() => parseLocationArgs(["--query", "query.jpg"]), /--manifest is required/);
	assert.throws(
		() => parseLocationArgs(["--manifest", "locations.json"]),
		/--query or --query-manifest is required/,
	);
	assert.throws(
		() =>
			parseLocationArgs([
				"--manifest",
				"locations.json",
				"--query",
				"query.jpg",
				"--query-manifest",
				"holdout.jsonl",
			]),
		/--query and --query-manifest cannot be used together/,
	);
	assert.throws(
		() =>
			parseLocationArgs([
				"--manifest",
				"locations.json",
				"--query",
				"query.jpg",
				"--top-k",
				"0",
			]),
		/--top-k must be a positive integer/,
	);
});

test("writes and reuses a fingerprinted reference embedding cache", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "gemini-indoor-localization-"));
	await mkdir(path.join(root, "reference"));
	await mkdir(path.join(root, "holdout"));
	await writeFile(path.join(root, "reference", "a.jpg"), Buffer.from("reference-a"));
	await writeFile(path.join(root, "holdout", "query.jpg"), Buffer.from("query"));
	const manifestPath = path.join(root, "references.json");
	const cachePath = path.join(root, "cache", "embeddings.json");
	const queryManifestPath = path.join(root, "queries.json");
	await writeFile(
		manifestPath,
		JSON.stringify([{ id: "a", file: "reference/a.jpg", location: { floor: "1F", x: 0, y: 0 } }]),
	);
	await writeFile(
		queryManifestPath,
		JSON.stringify([{ id: "q", file: "holdout/query.jpg", expectedReferenceId: "a" }]),
	);
	let referenceCalls = 0;
	const embedder = {
		dimensions: 2,
		model: "test-embedder",
		embed: async ({ filePath }) => {
			if (filePath.endsWith("reference/a.jpg")) referenceCalls += 1;
			return filePath.endsWith("reference/a.jpg") ? [1, 0] : [1, 0];
		},
	};
	await evaluateLocationQueries({
		embedder,
		manifestPath,
		queryManifestPath,
		referenceCachePath: cachePath,
	});
	assert.equal(referenceCalls, 1);
	const cached = JSON.parse(await readFile(cachePath, "utf8"));
	assert.equal(cached.version, 1);
	assert.equal(cached.model, "test-embedder");
	assert.equal(cached.references[0].sha256.length, 64);
	await evaluateLocationQueries({
		embedder,
		manifestPath,
		queryManifestPath,
		referenceCachePath: cachePath,
	});
	assert.equal(referenceCalls, 1);
	await writeFile(path.join(root, "reference", "a.jpg"), Buffer.from("reference-a-updated"));
	await evaluateLocationQueries({
		embedder,
		manifestPath,
		queryManifestPath,
		referenceCachePath: cachePath,
	});
	assert.equal(referenceCalls, 2);
});

test("validates and loads holdout query manifests", async () => {
	const query = {
		expectedReferenceId: "lobby-01",
		file: "holdout/lobby.jpg",
		id: "holdout-01",
	};
	assert.deepEqual(parseLocationQueryManifest(JSON.stringify([query])), [
		{ ...query, mimeType: "image/jpeg" },
	]);
	assert.deepEqual(
		parseLocationQueryManifest(JSON.stringify({ queries: [{ ...query, mimeType: "video/mp4" }] })),
		[{ ...query, mimeType: "video/mp4" }],
	);
	assert.throws(
		() => parseLocationQueryManifest(JSON.stringify([{ ...query, id: "" }])),
		/entry 1\.id must be a non-empty string/,
	);
	assert.throws(
		() => parseLocationQueryManifest(JSON.stringify([query, query])),
		/duplicate query id holdout-01/,
	);

	const root = await mkdtemp(path.join(tmpdir(), "gemini-indoor-localization-"));
	await mkdir(path.join(root, "holdout"));
	await writeFile(path.join(root, "holdout", "lobby.jpg"), Buffer.from("image"));
	const manifestPath = path.join(root, "holdout.json");
	await writeFile(manifestPath, JSON.stringify([query]));
	const queries = await loadLocationQueryManifest(manifestPath);
	assert.equal(queries[0].filePath, path.join(root, "holdout", "lobby.jpg"));
	assert.equal(
		parseLocationQueryManifest(
			JSON.stringify([{ id: "unlabeled", file: "holdout/stairs.jpg", expectedReferenceId: null }]),
		)[0].expectedReferenceId,
		null,
	);
});

test("evaluates every holdout and keeps ambiguous and provider failures in the report", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "gemini-indoor-localization-"));
	await mkdir(path.join(root, "reference"));
	await mkdir(path.join(root, "holdout"));
	for (const file of ["a.jpg", "b.jpg"]) {
		await writeFile(path.join(root, "reference", file), file);
	}
	for (const file of ["a.jpg", "ambiguous.jpg", "error.jpg"]) {
		await writeFile(path.join(root, "holdout", file), file);
	}
	const referenceManifestPath = path.join(root, "references.json");
	const queryManifestPath = path.join(root, "queries.json");
	await writeFile(
		referenceManifestPath,
		JSON.stringify([
			{ id: "a", file: "reference/a.jpg", location: { floor: "1F", x: 0, y: 0 } },
			{ id: "b", file: "reference/b.jpg", location: { floor: "1F", x: 10, y: 0 } },
		]),
	);
	await writeFile(
		queryManifestPath,
		JSON.stringify([
			{ id: "q-a", file: "holdout/a.jpg", expectedReferenceId: "a" },
			{ id: "q-ambiguous", file: "holdout/ambiguous.jpg", expectedReferenceId: "b" },
			{ id: "q-error", file: "holdout/error.jpg", expectedReferenceId: "a" },
		]),
	);
	const result = await evaluateLocationQueries({
		embedder: {
			dimensions: 2,
			model: "test-embedder",
			embed: async ({ filePath }) => {
				if (filePath.endsWith("error.jpg")) throw new Error("provider unavailable");
				if (filePath.endsWith("b.jpg")) return [0, 1];
				if (filePath.endsWith("ambiguous.jpg")) return [1, 1];
				return [1, 0];
			},
		},
		manifestPath: referenceManifestPath,
		minMargin: 0.1,
		minScore: 0.5,
		queryManifestPath,
		topK: 2,
	});
	assert.deepEqual(result.metrics.statusCounts, {
		matched: 1,
		ambiguous: 1,
		no_match: 0,
		error: 1,
	});
	assert.equal(result.metrics.total, 3);
	assert.equal(result.metrics.top1Accuracy, 1 / 3);
	assert.equal(result.metrics.topKAccuracy, 2 / 3);
	assert.equal(result.queries[2].status, "error");
	assert.equal(result.queries[2].error, "provider unavailable");
});

test("keeps reference embedding failures explicit and marks evaluation incomplete", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "gemini-indoor-localization-"));
	await mkdir(path.join(root, "reference"));
	await mkdir(path.join(root, "holdout"));
	await writeFile(path.join(root, "reference", "a.jpg"), Buffer.from("a"));
	await writeFile(path.join(root, "reference", "b.jpg"), Buffer.from("b"));
	await writeFile(path.join(root, "holdout", "query.jpg"), Buffer.from("query"));
	const referenceManifestPath = path.join(root, "references.json");
	const queryManifestPath = path.join(root, "queries.json");
	await writeFile(
		referenceManifestPath,
		JSON.stringify([
			{ id: "a", file: "reference/a.jpg", location: { floor: "1F", x: 0, y: 0 } },
			{ id: "b", file: "reference/b.jpg", location: { floor: "1F", x: 10, y: 0 } },
		]),
	);
	await writeFile(
		queryManifestPath,
		JSON.stringify([{ id: "q", file: "holdout/query.jpg", expectedReferenceId: "a" }]),
	);
	const result = await evaluateLocationQueries({
		embedder: {
			dimensions: 2,
			model: "test-embedder",
			embed: async ({ filePath }) => {
				if (filePath.endsWith("b.jpg")) throw new Error("provider unavailable");
				return [1, 0];
			},
		},
		manifestPath: referenceManifestPath,
		queryManifestPath,
	});
	assert.equal(result.evaluationComplete, false);
	assert.deepEqual(result.metrics.statusCounts, {
		matched: 0,
		ambiguous: 0,
		no_match: 0,
		error: 1,
	});
	assert.equal(result.metrics.top1Accuracy, null);
	assert.deepEqual(result.referenceEmbeddingErrors, [
		{ error: "provider unavailable", file: "reference/b.jpg", id: "b" },
	]);
	assert.match(result.queries[0].error, /Reference embedding failed for b/);
});

test("keeps unknown holdouts in the report without counting them in accuracy", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "gemini-indoor-localization-"));
	await mkdir(path.join(root, "reference"));
	await mkdir(path.join(root, "holdout"));
	for (const file of ["a.jpg", "b.jpg"]) {
		await writeFile(path.join(root, "reference", file), file);
	}
	for (const file of ["a.jpg", "stairs.jpg"]) {
		await writeFile(path.join(root, "holdout", file), file);
	}
	const referenceManifestPath = path.join(root, "references.json");
	const queryManifestPath = path.join(root, "queries.json");
	await writeFile(
		referenceManifestPath,
		JSON.stringify([
			{ id: "a", file: "reference/a.jpg", location: { floor: "1F", x: 0, y: 0 } },
			{ id: "b", file: "reference/b.jpg", location: { floor: "1F", x: 10, y: 0 } },
		]),
	);
	await writeFile(
		queryManifestPath,
		JSON.stringify([
			{ id: "q-a", file: "holdout/a.jpg", expectedReferenceId: "a" },
			{ id: "q-stairs", file: "holdout/stairs.jpg", expectedReferenceId: null },
		]),
	);
	const result = await evaluateLocationQueries({
		embedder: {
			dimensions: 2,
			model: "test-embedder",
			embed: async ({ filePath }) => {
				if (filePath.endsWith("b.jpg")) return [0, 1];
				if (filePath.endsWith("stairs.jpg")) return [0.1, 0.1];
				return [1, 0];
			},
		},
		manifestPath: referenceManifestPath,
		minScore: 0.9,
		queryManifestPath,
	});
	assert.equal(result.evaluationComplete, true);
	assert.equal(result.metrics.total, 2);
	assert.equal(result.metrics.evaluable, 1);
	assert.equal(result.metrics.accuracyDenominator, 1);
	assert.equal(result.metrics.top1Accuracy, 1);
	assert.equal(result.metrics.topKAccuracy, 1);
	assert.equal(result.queries[1].groundTruthAvailable, false);
	assert.equal(result.queries[1].top1Correct, null);
	assert.equal(result.queries[1].status, "no_match");
});

test("validates location manifest entries and supports JSON and JSONL", () => {
	const entry = {
		file: "lobby.jpg",
		id: "lobby-01",
		label: "1F lobby",
		location: { floor: "1F", x: 10, y: 20, z: 1.5 },
	};
	assert.deepEqual(parseLocationManifest(JSON.stringify([entry])), [
		{ ...entry, mimeType: "image/jpeg" },
	]);
	assert.deepEqual(parseLocationManifest(`${JSON.stringify(entry)}\n`), [
		{ ...entry, mimeType: "image/jpeg" },
	]);
	assert.deepEqual(parseLocationManifest(JSON.stringify([{ ...entry, mimeType: "video/mp4" }])), [
		{ ...entry, mimeType: "video/mp4" },
	]);
	assert.throws(
		() => parseLocationManifest(JSON.stringify([{ ...entry, id: "lobby-01" }, entry])),
		/duplicate reference id lobby-01/,
	);
	assert.throws(
		() =>
			parseLocationManifest(
				JSON.stringify([{ ...entry, location: { floor: "1F", x: "10", y: 20 } }]),
			),
		/location\.x must be a finite number/,
	);
	assert.throws(
		() => parseLocationManifest(JSON.stringify([{ ...entry, file: "lobby.txt" }])),
		/Unsupported media extension \.txt/,
	);
	assert.throws(
		() => parseLocationManifest(JSON.stringify([{ ...entry, mimeType: "image/heic" }])),
		/mimeType must be image\/jpeg, image\/png, video\/mp4, or video\/quicktime/,
	);
});

test("loads media paths relative to the manifest", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "gemini-indoor-localization-"));
	await mkdir(path.join(root, "media"));
	await writeFile(path.join(root, "media", "lobby.jpg"), Buffer.from("image"));
	const manifestPath = path.join(root, "locations.json");
	await writeFile(
		manifestPath,
		JSON.stringify([
			{ id: "lobby", file: "media/lobby.jpg", location: { floor: "1F", x: 1, y: 2 } },
		]),
	);
	const references = await loadLocationManifest(manifestPath);
	assert.equal(references[0].filePath, path.join(root, "media", "lobby.jpg"));
});

test("builds a Gemini multimodal request with inline_data and validates the 3072 vector", async () => {
	let captured;
	const result = await requestGeminiMediaEmbedding({
		apiKey: "google-key",
		bytes: Buffer.from("image-bytes"),
		dimensions: LOCATION_EMBEDDING_DIMENSIONS,
		fetcher: async (input, init) => {
			captured = { input, init };
			return new Response(
				JSON.stringify({ embedding: { values: [0.25, ...Array.from({ length: 3071 }, () => 0)] } }),
				{ status: 200 },
			);
		},
		mimeType: "image/jpeg",
	});
	assert.equal(result.length, LOCATION_EMBEDDING_DIMENSIONS);
	assert.equal(
		captured.input,
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
	);
	assert.equal(captured.init.headers["x-goog-api-key"], "google-key");
	const body = JSON.parse(captured.init.body);
	assert.equal(body.output_dimensionality, LOCATION_EMBEDDING_DIMENSIONS);
	assert.deepEqual(body.content.parts[0].inline_data, {
		data: Buffer.from("image-bytes").toString("base64"),
		mime_type: "image/jpeg",
	});
	assert.equal(body.model, "models/gemini-embedding-2");
	assert.equal(LOCATION_EMBEDDING_MODEL, "gemini-embedding-2");
});

test("supports the configured Cloudflare AI Gateway without changing the payload", async () => {
	let captured;
	await requestGeminiMediaEmbedding({
		apiKey: "google-key",
		bytes: Buffer.from("image-bytes"),
		dimensions: 128,
		fetcher: async (input, init) => {
			captured = { input, init };
			return new Response(
				JSON.stringify({ embedding: { values: [0.5, ...Array.from({ length: 127 }, () => 0)] } }),
				{ status: 200 },
			);
		},
		gateway: { accountId: "account/id", gatewayId: "gate", token: "gateway-token" },
		mimeType: "image/jpeg",
	});
	assert.equal(
		captured.input,
		"https://gateway.ai.cloudflare.com/v1/account%2Fid/gate/google-ai-studio/v1/models/gemini-embedding-2:embedContent",
	);
	assert.equal(captured.init.headers["cf-aig-authorization"], "Bearer gateway-token");
	assert.equal(JSON.parse(captured.init.body).output_dimensionality, 128);
	await assert.rejects(
		() =>
			requestGeminiMediaEmbedding({
				apiKey: "google-key",
				bytes: Buffer.from("image-bytes"),
				dimensions: 128,
				gateway: { accountId: "account", gatewayId: "gate" },
				mimeType: "image/jpeg",
				fetcher: async () => new Response("", { status: 200 }),
			}),
		/AI Gateway configuration requires accountId, gatewayId, and token/,
	);
});

test("supports ADC access tokens through the Vertex AI endpoint", async () => {
	let captured;
	await requestGeminiMediaEmbedding({
		accessToken: "adc-token",
		bytes: Buffer.from("image-bytes"),
		dimensions: 128,
		fetcher: async (input, init) => {
			captured = { input, init };
			return new Response(
				JSON.stringify({ embedding: { values: [0.5, ...Array.from({ length: 127 }, () => 0)] } }),
				{ status: 200 },
			);
		},
		mimeType: "image/jpeg",
		projectId: "example-project-id",
	});
	assert.equal(
		captured.input,
		"https://aiplatform.googleapis.com/v1/projects/example-project-id/locations/global/publishers/google/models/gemini-embedding-2:embedContent",
	);
	assert.equal(captured.init.headers.authorization, "Bearer adc-token");
	assert.equal(captured.init.headers["x-goog-user-project"], "example-project-id");
	assert.equal(JSON.parse(captured.init.body).model, undefined);
});

test("reports provider errors without exposing response bodies", async () => {
	await assert.rejects(
		() =>
			requestGeminiMediaEmbedding({
				apiKey: "google-key",
				bytes: Buffer.from("video-bytes"),
				dimensions: 3072,
				fetcher: async () => new Response("private provider details", { status: 429 }),
				mimeType: "video/mp4",
			}),
		(error) =>
			error instanceof LocationEmbeddingError &&
			error.message === "Gemini embedding request failed with HTTP 429.",
	);
	await assert.rejects(
		() =>
			requestGeminiMediaEmbedding({
				apiKey: "google-key",
				bytes: Buffer.from("image-bytes"),
				dimensions: 3072,
				fetcher: async () =>
					new Response(JSON.stringify({ embedding: { values: [1] } }), { status: 200 }),
				mimeType: "image/png",
			}),
		/Gemini returned 1 dimensions, expected 3072/,
	);
});

test("reads image and video MIME types", async () => {
	assert.equal(inferMediaMimeType("camera.JPG"), "image/jpeg");
	assert.equal(inferMediaMimeType("walkthrough.mp4"), "video/mp4");
	assert.throws(() => inferMediaMimeType("notes.txt"), LocationInputError);
	await assert.rejects(
		() => requestGeminiMediaEmbedding({ apiKey: "google-key", bytes: Buffer.from("image") }),
		/mimeType must be image\/jpeg, image\/png, video\/mp4, or video\/quicktime/,
	);
});

test("ranks candidates, estimates weighted coordinates, and marks ambiguity", () => {
	const references = [
		{ id: "a", location: { floor: "1F", x: 0, y: 0 }, embedding: [1, 0] },
		{ id: "b", location: { floor: "1F", x: 10, y: 0 }, embedding: [0.99, 0.1] },
		{ id: "c", location: { floor: "2F", x: 100, y: 100 }, embedding: [0, 1] },
	];
	const matched = rankLocationCandidates([1, 0], references, {
		minMargin: 0.001,
		minScore: 0.8,
		topK: 3,
	});
	assert.equal(matched.status, "matched");
	assert.equal(matched.candidates[0].id, "a");
	assert.equal(matched.estimate.floor, "1F");
	assert.ok(matched.estimate.x > 0 && matched.estimate.x < 10);
	assert.equal(matched.evidence.candidateCount, 3);

	const ambiguous = rankLocationCandidates([1, 0], references, {
		minMargin: 0.1,
		minScore: 0.8,
	});
	assert.equal(ambiguous.status, "ambiguous");
	assert.equal(ambiguous.estimate, null);

	const noMatch = rankLocationCandidates([1, 1], references, { minScore: 0.99 });
	assert.equal(noMatch.status, "no_match");
	assert.equal(noMatch.estimate, null);

	const topOneStillChecksMargin = rankLocationCandidates([1, 0], references, {
		minMargin: 0.1,
		minScore: 0.8,
		topK: 1,
	});
	assert.equal(topOneStillChecksMargin.status, "ambiguous");
	assert.equal(topOneStillChecksMargin.candidates.length, 1);
	assert.ok(topOneStillChecksMargin.evidence.margin < 0.1);
});

test("cosine similarity rejects mismatched and non-finite vectors", () => {
	assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
	assert.throws(() => cosineSimilarity([1], [1, 0]), /dimensions 1 and 2/);
	assert.throws(() => cosineSimilarity([Number.NaN], [1]), /finite vector/);
});

test("createGeminiMediaEmbedder reads files, applies the default model, and enforces size", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "gemini-indoor-localization-"));
	const filePath = path.join(root, "query.png");
	await writeFile(filePath, Buffer.from("image"));
	let calls = 0;
	const embedder = createGeminiMediaEmbedder({
		apiKey: "google-key",
		maxInlineBytes: 5,
		fetcher: async () => {
			calls += 1;
			return new Response(
				JSON.stringify({ embedding: { values: [1, ...Array.from({ length: 127 }, () => 0)] } }),
				{ status: 200 },
			);
		},
		dimensions: 128,
	});
	assert.equal(embedder.model, LOCATION_EMBEDDING_MODEL);
	assert.equal(embedder.dimensions, 128);
	assert.equal((await embedder.embed({ filePath }))[0], 1);
	assert.equal(calls, 1);
	await writeFile(filePath, Buffer.from("too-large"));
	await assert.rejects(() => embedder.embed({ filePath }), /over the inline limit/);
});
