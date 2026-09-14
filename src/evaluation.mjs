import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { LocationInputError } from "./errors.mjs";
import {
	fingerprintLocationMedia,
	inferMediaMimeType,
	loadLocationManifest,
	loadLocationQueryManifest,
} from "./manifest.mjs";
import { rankLocationCandidates } from "./matching.mjs";

export async function locateMedia(options) {
	const references = await loadLocationManifest(options.manifestPath);
	const embeddedReferences = (
		await embedLocationReferences(references, options.embedder, {
			cachePath: options.referenceCachePath,
		})
	).references;
	const queryPath = path.resolve(options.queryPath);
	const queryEmbedding = await options.embedder.embed({
		filePath: queryPath,
		mimeType: options.queryMimeType ?? inferMediaMimeType(queryPath),
	});
	return {
		model: options.embedder.model,
		dimensions: options.embedder.dimensions,
		query: queryPath,
		...rankLocationCandidates(queryEmbedding, embeddedReferences, options),
	};
}

export async function evaluateLocationQueries(options) {
	const references = await loadLocationManifest(options.manifestPath);
	const queries = await loadLocationQueryManifest(options.queryManifestPath);
	const referenceById = new Map(references.map((reference) => [reference.id, reference]));
	for (const query of queries) {
		if (query.expectedReferenceId !== null && !referenceById.has(query.expectedReferenceId)) {
			throw new LocationInputError(
				`Query ${query.id} refers to unknown reference ${query.expectedReferenceId}.`,
			);
		}
	}
	const referenceEmbedding = await embedLocationReferences(references, options.embedder, {
		collectErrors: true,
		cachePath: options.referenceCachePath,
	});
	if (referenceEmbedding.failures.length > 0) {
		const error = `Reference embedding failed for ${referenceEmbedding.failures.map((failure) => failure.id).join(", ")}.`;
		const results = queries.map((query) => ({
			error,
			expectedReferenceId: query.expectedReferenceId,
			file: query.file,
			id: query.id,
			status: "error",
			groundTruthAvailable: query.expectedReferenceId !== null,
			top1Correct: query.expectedReferenceId === null ? null : false,
			topKCorrect: query.expectedReferenceId === null ? null : false,
			floorTop1Correct: query.expectedReferenceId === null ? null : false,
		}));
		return {
			dimensions: options.embedder.dimensions,
			evaluationComplete: false,
			metrics: summarizeLocationMetrics(results, false),
			model: options.embedder.model,
			queries: results,
			referenceCount: references.length,
			referenceEmbeddingErrors: referenceEmbedding.failures,
		};
	}
	const embeddedReferences = referenceEmbedding.references;
	const results = [];
	for (const query of queries) {
		try {
			const queryEmbedding = await options.embedder.embed({
				filePath: query.filePath,
				mimeType: query.mimeType,
			});
			const ranking = rankLocationCandidates(queryEmbedding, embeddedReferences, options);
			const topCandidate = ranking.candidates[0];
			results.push({
				...ranking,
				expectedReferenceId: query.expectedReferenceId,
				file: query.file,
				id: query.id,
				groundTruthAvailable: query.expectedReferenceId !== null,
				top1Correct:
					query.expectedReferenceId === null
						? null
						: topCandidate?.id === query.expectedReferenceId,
				topKCorrect:
					query.expectedReferenceId === null
						? null
						: ranking.candidates.some((candidate) => candidate.id === query.expectedReferenceId),
				floorTop1Correct:
					query.expectedReferenceId === null
						? null
						: topCandidate?.location.floor ===
							referenceById.get(query.expectedReferenceId)?.location.floor,
			});
		} catch (error) {
			results.push({
				error: error instanceof Error ? error.message : "Unknown location query failure.",
				expectedReferenceId: query.expectedReferenceId,
				file: query.file,
				id: query.id,
				status: "error",
				groundTruthAvailable: query.expectedReferenceId !== null,
				top1Correct: query.expectedReferenceId === null ? null : false,
				topKCorrect: query.expectedReferenceId === null ? null : false,
				floorTop1Correct: query.expectedReferenceId === null ? null : false,
			});
		}
	}
	return {
		dimensions: options.embedder.dimensions,
		evaluationComplete: true,
		metrics: summarizeLocationMetrics(results, true),
		model: options.embedder.model,
		queries: results,
		referenceCount: references.length,
	};
}

async function embedLocationReferences(references, embedder, options = {}) {
	const cached = options.cachePath ? await loadReferenceEmbeddingCache(options.cachePath) : null;
	const embeddedReferences = [];
	const failures = [];
	for (const reference of references) {
		try {
			const fingerprint = await fingerprintLocationMedia(reference.filePath);
			const cachedReference = cached?.references.find(
				(item) =>
					cached.model === embedder.model &&
					cached.dimensions === embedder.dimensions &&
					item.id === reference.id &&
					item.file === reference.file &&
					item.mimeType === reference.mimeType &&
					item.bytes === fingerprint.bytes &&
					item.sha256 === fingerprint.sha256 &&
					item.embedding?.length === embedder.dimensions,
			);
			const embedding = cachedReference
				? cachedReference.embedding
				: await embedder.embed({
						filePath: reference.filePath,
						mimeType: reference.mimeType,
					});
			embeddedReferences.push({ ...reference, embedding, fingerprint });
		} catch (error) {
			if (!options.collectErrors) throw error;
			failures.push({
				error: error instanceof Error ? error.message : "Unknown reference embedding failure.",
				file: reference.file,
				id: reference.id,
			});
		}
	}
	if (options.cachePath && failures.length === 0) {
		await saveReferenceEmbeddingCache(options.cachePath, embedder, embeddedReferences);
	}
	return { failures, references: embeddedReferences };
}

async function loadReferenceEmbeddingCache(cachePath) {
	try {
		const parsed = JSON.parse(await readFile(cachePath, "utf8"));
		if (
			parsed?.version !== 1 ||
			typeof parsed.model !== "string" ||
			!Number.isInteger(parsed.dimensions) ||
			!Array.isArray(parsed.references)
		) {
			return null;
		}
		return parsed;
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw new LocationInputError(`Cannot read reference embedding cache ${cachePath}.`);
	}
}

async function saveReferenceEmbeddingCache(cachePath, embedder, references) {
	const absoluteCachePath = path.resolve(cachePath);
	await mkdir(path.dirname(absoluteCachePath), { recursive: true });
	const payload = {
		dimensions: embedder.dimensions,
		generatedAt: new Date().toISOString(),
		model: embedder.model,
		references: references.map((reference) => ({
			bytes: reference.fingerprint.bytes,
			embedding: reference.embedding,
			file: reference.file,
			id: reference.id,
			label: reference.label,
			location: reference.location,
			mimeType: reference.mimeType,
			sha256: reference.fingerprint.sha256,
		})),
		version: 1,
	};
	await writeFile(absoluteCachePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function summarizeLocationMetrics(results, evaluationComplete) {
	const successfulResults = results.filter((result) => result.status !== "error");
	const evaluableResults = successfulResults.filter(
		(result) => result.groundTruthAvailable !== false,
	);
	const total = results.length;
	const accuracyDenominator = successfulResults.length === total ? evaluableResults.length : total;
	return {
		accuracyDenominator,
		evaluable: evaluableResults.length,
		floorTop1Accuracy: evaluationComplete
			? ratio(
					evaluableResults.filter((result) => result.floorTop1Correct).length,
					accuracyDenominator,
				)
			: null,
		statusCounts: Object.fromEntries(
			["matched", "ambiguous", "no_match", "error"].map((status) => [
				status,
				results.filter((result) => result.status === status).length,
			]),
		),
		top1Accuracy: evaluationComplete
			? ratio(evaluableResults.filter((result) => result.top1Correct).length, accuracyDenominator)
			: null,
		topKAccuracy: evaluationComplete
			? ratio(evaluableResults.filter((result) => result.topKCorrect).length, accuracyDenominator)
			: null,
		total,
	};
}

function ratio(numerator, denominator) {
	return denominator === 0 ? null : numerator / denominator;
}
