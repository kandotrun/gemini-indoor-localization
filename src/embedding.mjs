import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
	DEFAULT_MAX_INLINE_BYTES,
	DIRECT_EMBEDDING_ENDPOINT,
	LOCATION_EMBEDDING_DIMENSIONS,
	LOCATION_EMBEDDING_MODEL,
} from "./constants.mjs";
import { LocationEmbeddingError, LocationInputError, assertFiniteVector, requireMediaMimeType } from "./errors.mjs";
import { inferMediaMimeType } from "./manifest.mjs";

const execFileAsync = promisify(execFile);

export function createGeminiMediaEmbedder(options = {}) {
	const apiKey = options.apiKey?.trim();
	const accessToken = options.accessToken?.trim();
	const projectId = options.projectId?.trim();
	if (apiKey && accessToken) {
		throw new LocationInputError(
			"GEMINI_API_KEY and GEMINI_ACCESS_TOKEN cannot be used together.",
		);
	}
	if (!apiKey && !accessToken && !projectId) {
		throw new LocationInputError(
			"GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT is required for location inference.",
		);
	}
	if (accessToken && !projectId) {
		throw new LocationInputError("GOOGLE_CLOUD_PROJECT is required when using ADC.");
	}
	const fetcher = options.fetcher ?? fetch;
	const dimensions = options.dimensions ?? LOCATION_EMBEDDING_DIMENSIONS;
	if (
		!Number.isInteger(dimensions) ||
		dimensions < 128 ||
		dimensions > LOCATION_EMBEDDING_DIMENSIONS
	) {
		throw new LocationInputError(
			"Embedding dimensions must be an integer between 128 and 3072.",
		);
	}
	const maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
	const gateway = normalizeGateway(options.gateway);
	if (gateway && !apiKey && (accessToken || projectId)) {
		throw new LocationInputError("AI Gateway cannot be combined with ADC authentication.");
	}
	let accessTokenPromise;
	const getAccessToken = async () => {
		if (apiKey) return undefined;
		if (accessToken) return accessToken;
		if (!projectId) return undefined;
		accessTokenPromise ??= getGcloudApplicationDefaultAccessToken(options.gcloudPath);
		return accessTokenPromise;
	};

	return {
		dimensions,
		model: LOCATION_EMBEDDING_MODEL,
		async embed(media) {
			const mimeType = media.mimeType ?? inferMediaMimeType(media.filePath);
			const bytes = await readFile(media.filePath);
			if (bytes.length === 0) {
				throw new LocationInputError(`Media file is empty: ${media.filePath}`);
			}
			if (bytes.length > maxInlineBytes) {
				throw new LocationInputError(
					`Media file is ${bytes.length} bytes, over the inline limit of ${maxInlineBytes} bytes: ${media.filePath}`,
				);
			}
			return requestGeminiMediaEmbedding({
				accessToken: await getAccessToken(),
				apiKey,
				bytes,
				dimensions,
				fetcher,
				gateway,
				mimeType,
				projectId,
			});
		},
	};
}

export async function requestGeminiMediaEmbedding(options) {
	const gateway = normalizeGateway(options.gateway);
	const mimeType = requireMediaMimeType(options.mimeType, "media");
	const apiKey = options.apiKey?.trim();
	const accessToken = options.accessToken?.trim();
	const projectId = options.projectId?.trim();
	if (!apiKey && !accessToken) {
		throw new LocationInputError("Gemini API key or ADC access token is required.");
	}
	if (gateway && accessToken) {
		throw new LocationInputError("AI Gateway cannot be combined with ADC authentication.");
	}
	if (accessToken && !projectId) {
		throw new LocationInputError("GOOGLE_CLOUD_PROJECT is required when using ADC.");
	}
	const headers = { "content-type": "application/json" };
	if (accessToken) {
		headers.authorization = `Bearer ${accessToken}`;
		headers["x-goog-user-project"] = projectId;
	} else {
		headers["x-goog-api-key"] = apiKey;
	}
	if (gateway) {
		headers["cf-aig-authorization"] = `Bearer ${gateway.token}`;
	}
	const requestPayload = {
		content: {
			parts: [
				{
					inline_data: {
						data: Buffer.from(options.bytes).toString("base64"),
						mime_type: mimeType,
					},
				},
			],
		},
		output_dimensionality: options.dimensions,
	};
	if (!accessToken) requestPayload.model = "models/gemini-embedding-2";
	const response = await options.fetcher(
		buildEmbeddingEndpoint(gateway, projectId, Boolean(accessToken)),
		{
			method: "POST",
			headers,
			signal: options.signal ?? AbortSignal.timeout(30_000),
			body: JSON.stringify(requestPayload),
		},
	);

	if (!response.ok) {
		throw new LocationEmbeddingError(
			`Gemini embedding request failed with HTTP ${response.status}.`,
		);
	}

	let responsePayload;
	try {
		responsePayload = await response.json();
	} catch (error) {
		throw new LocationEmbeddingError("Gemini embedding response was not valid JSON.", {
			cause: error,
		});
	}
	const values = responsePayload?.embedding?.values ?? responsePayload?.embeddings?.[0]?.values;
	if (!Array.isArray(values)) {
		throw new LocationEmbeddingError("Gemini embedding response did not include values.");
	}
	if (values.length !== options.dimensions) {
		throw new LocationEmbeddingError(
			`Gemini returned ${values.length} dimensions, expected ${options.dimensions}.`,
		);
	}
	assertFiniteVector(values, "Gemini embedding response");
	return values;
}

function buildEmbeddingEndpoint(gateway, projectId, useAdc) {
	if (useAdc) {
		return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/global/publishers/google/models/gemini-embedding-2:embedContent`;
	}
	if (!gateway) return DIRECT_EMBEDDING_ENDPOINT;
	return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(gateway.accountId)}/${encodeURIComponent(gateway.gatewayId)}/google-ai-studio/v1/models/gemini-embedding-2:embedContent`;
}

async function getGcloudApplicationDefaultAccessToken(gcloudPath) {
	try {
		const result = await execFileAsync(gcloudPath ?? "gcloud", [
			"auth",
			"application-default",
			"print-access-token",
		]);
		const token = result.stdout.trim();
		if (!token) throw new Error("empty access token");
		return token;
	} catch {
		throw new LocationEmbeddingError(
			"Could not obtain an ADC access token with gcloud. Run `gcloud auth application-default login` first.",
		);
	}
}

function normalizeGateway(value) {
	if (!value) return null;
	const accountId = typeof value.accountId === "string" ? value.accountId.trim() : "";
	const gatewayId = typeof value.gatewayId === "string" ? value.gatewayId.trim() : "";
	const token = typeof value.token === "string" ? value.token.trim() : "";
	const configuredValues = [accountId, gatewayId, token].filter(Boolean).length;
	if (configuredValues === 0) return null;
	if (configuredValues !== 3) {
		throw new LocationInputError(
			"AI Gateway configuration requires accountId, gatewayId, and token.",
		);
	}
	return { accountId, gatewayId, token };
}
