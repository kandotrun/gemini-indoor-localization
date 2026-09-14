import {
	DEFAULT_MIN_MARGIN,
	DEFAULT_MIN_SCORE,
	DEFAULT_TOP_K,
} from "./constants.mjs";
import { LocationInputError, parseBoundedNumber, parsePositiveInteger, requireValue } from "./errors.mjs";

export function parseLocationArgs(args) {
	const parsed = {
		manifest: undefined,
		minMargin: DEFAULT_MIN_MARGIN,
		minScore: DEFAULT_MIN_SCORE,
		query: undefined,
		queryManifest: undefined,
		referenceCache: undefined,
		topK: DEFAULT_TOP_K,
	};

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--manifest") {
			parsed.manifest = requireValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg === "--query") {
			parsed.query = requireValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg === "--query-manifest") {
			parsed.queryManifest = requireValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg === "--reference-cache") {
			parsed.referenceCache = requireValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg === "--top-k") {
			parsed.topK = parsePositiveInteger(requireValue(args, index, arg), arg);
			index += 1;
			continue;
		}
		if (arg === "--min-score") {
			parsed.minScore = parseBoundedNumber(requireValue(args, index, arg), arg, -1, 1);
			index += 1;
			continue;
		}
		if (arg === "--min-margin") {
			parsed.minMargin = parseBoundedNumber(requireValue(args, index, arg), arg, 0, 2);
			index += 1;
			continue;
		}
		throw new LocationInputError(`Unknown location argument: ${arg}`);
	}

	if (!parsed.manifest) {
		throw new LocationInputError("--manifest is required.");
	}
	if (!parsed.query && !parsed.queryManifest) {
		throw new LocationInputError("--query or --query-manifest is required.");
	}
	if (parsed.query && parsed.queryManifest) {
		throw new LocationInputError("--query and --query-manifest cannot be used together.");
	}
	return parsed;
}
