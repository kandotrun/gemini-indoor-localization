import { DEFAULT_MIN_MARGIN, DEFAULT_MIN_SCORE, DEFAULT_TOP_K } from "./constants.mjs";
import { LocationInputError, assertFiniteVector } from "./errors.mjs";

export function cosineSimilarity(left, right) {
	if (left.length !== right.length) {
		throw new LocationInputError(
			`Cannot compare vectors with dimensions ${left.length} and ${right.length}.`,
		);
	}
	assertFiniteVector(left, "left vector");
	assertFiniteVector(right, "right vector");

	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index += 1) {
		dot += left[index] * right[index];
		leftNorm += left[index] ** 2;
		rightNorm += right[index] ** 2;
	}
	if (leftNorm === 0 || rightNorm === 0) {
		throw new LocationInputError("Cannot compare a zero-length vector.");
	}
	return dot / Math.sqrt(leftNorm * rightNorm);
}

export function rankLocationCandidates(queryEmbedding, references, options = {}) {
	assertFiniteVector(queryEmbedding, "query embedding");
	const topK = options.topK ?? DEFAULT_TOP_K;
	const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
	const minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN;
	if (!Number.isInteger(topK) || topK < 1) {
		throw new LocationInputError("topK must be a positive integer.");
	}
	if (!Number.isFinite(minScore) || minScore < -1 || minScore > 1) {
		throw new LocationInputError("minScore must be between -1 and 1.");
	}
	if (!Number.isFinite(minMargin) || minMargin < 0 || minMargin > 2) {
		throw new LocationInputError("minMargin must be between 0 and 2.");
	}

	const rankedCandidates = references
		.map((reference) => ({
			...reference,
			score: cosineSimilarity(queryEmbedding, reference.embedding),
		}))
		.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
	const candidates = rankedCandidates.slice(0, topK);
	const top = rankedCandidates[0];
	if (!top) {
		throw new LocationInputError("At least one location reference is required.");
	}
	const second = rankedCandidates[1];
	const margin = second ? top.score - second.score : null;
	const status =
		top.score < minScore ? "no_match" : second && margin < minMargin ? "ambiguous" : "matched";

	return {
		status,
		estimate: status === "matched" ? estimateLocation(candidates) : null,
		candidates: candidates.map(({ embedding: _embedding, file, ...candidate }) => ({
			...candidate,
			file,
		})),
		evidence: {
			candidateCount: references.length,
			margin,
			minMargin,
			minScore,
			topScore: top.score,
		},
	};
}

function estimateLocation(candidates) {
	const weighted = candidates.map((candidate) => ({
		candidate,
		weight: Math.max(candidate.score, 0) ** 4,
	}));
	const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
	if (totalWeight === 0) return weighted[0].candidate.location;

	const floorWeights = new Map();
	for (const item of weighted) {
		floorWeights.set(
			item.candidate.location.floor,
			(floorWeights.get(item.candidate.location.floor) ?? 0) + item.weight,
		);
	}
	const floor = [...floorWeights.entries()].sort(
		(left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
	)[0][0];
	const floorCandidates = weighted.filter((item) => item.candidate.location.floor === floor);
	const floorWeight = floorCandidates.reduce((sum, item) => sum + item.weight, 0);
	const location = {
		floor,
		x:
			floorCandidates.reduce((sum, item) => sum + item.candidate.location.x * item.weight, 0) /
			floorWeight,
		y:
			floorCandidates.reduce((sum, item) => sum + item.candidate.location.y * item.weight, 0) /
			floorWeight,
	};
	const zValues = floorCandidates.filter((item) => item.candidate.location.z !== undefined);
	if (zValues.length > 0) {
		location.z =
			zValues.reduce((sum, item) => sum + item.candidate.location.z * item.weight, 0) /
			zValues.reduce((sum, item) => sum + item.weight, 0);
	}
	return location;
}
