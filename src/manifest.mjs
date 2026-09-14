import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { MIME_TYPES_BY_EXTENSION, SUPPORTED_MEDIA_MIME_TYPES } from "./constants.mjs";
import {
	LocationInputError,
	requireFiniteNumber,
	requireMediaMimeType,
	requireNonEmptyString,
} from "./errors.mjs";

export function inferMediaMimeType(filePath) {
	const extension = path.extname(filePath).toLowerCase();
	const mimeType = MIME_TYPES_BY_EXTENSION.get(extension);
	if (!mimeType) {
		throw new LocationInputError(
			`Unsupported media extension ${extension || "(none)"}. Use PNG/JPEG images or MP4/MOV videos, or set a supported mimeType in the manifest.`,
		);
	}
	return mimeType;
}

export function parseLocationManifest(value, options = {}) {
	const manifestPath = options.manifestPath ?? "location manifest";
	let rows;
	let parsedJson = false;
	try {
		const parsed = JSON.parse(value);
		parsedJson = true;
		rows = Array.isArray(parsed) ? parsed : parsed?.references;
	} catch {
		parsedJson = false;
	}
	if (!parsedJson || !Array.isArray(rows)) {
		rows = value
			.split(/\r?\n/u)
			.map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
			.filter(({ line }) => line.length > 0)
			.map(({ line, lineNumber }) => {
				try {
					return JSON.parse(line);
				} catch {
					throw new LocationInputError(`${manifestPath}:${lineNumber} is not valid JSON.`);
				}
			});
	}

	if (!Array.isArray(rows) || rows.length === 0) {
		throw new LocationInputError(
			`${manifestPath} must contain a non-empty JSON array or JSONL references list.`,
		);
	}

	const seenIds = new Set();
	return rows.map((row, index) => {
		const reference = parseLocationReference(row, `${manifestPath} entry ${index + 1}`);
		if (seenIds.has(reference.id)) {
			throw new LocationInputError(
				`${manifestPath} contains duplicate reference id ${reference.id}.`,
			);
		}
		seenIds.add(reference.id);
		return reference;
	});
}

export async function loadLocationManifest(manifestPath) {
	const absoluteManifestPath = path.resolve(manifestPath);
	const value = await readFile(absoluteManifestPath, "utf8");
	const references = parseLocationManifest(value, { manifestPath: absoluteManifestPath });
	return references.map((reference) => ({
		...reference,
		filePath: path.resolve(path.dirname(absoluteManifestPath), reference.file),
	}));
}

export function parseLocationQueryManifest(value, options = {}) {
	const manifestPath = options.manifestPath ?? "location query manifest";
	let rows;
	let parsedJson = false;
	try {
		const parsed = JSON.parse(value);
		parsedJson = true;
		rows = Array.isArray(parsed) ? parsed : parsed?.queries;
	} catch {
		parsedJson = false;
	}
	if (!parsedJson || !Array.isArray(rows)) {
		rows = value
			.split(/\r?\n/u)
			.map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
			.filter(({ line }) => line.length > 0)
			.map(({ line, lineNumber }) => {
				try {
					return JSON.parse(line);
				} catch {
					throw new LocationInputError(`${manifestPath}:${lineNumber} is not valid JSON.`);
				}
			});
	}
	if (!Array.isArray(rows) || rows.length === 0) {
		throw new LocationInputError(
			`${manifestPath} must contain a non-empty JSON array or JSONL queries list.`,
		);
	}
	const seenIds = new Set();
	return rows.map((row, index) => {
		const label = `${manifestPath} entry ${index + 1}`;
		if (!row || typeof row !== "object" || Array.isArray(row)) {
			throw new LocationInputError(`${label} must be an object.`);
		}
		const id = requireNonEmptyString(row.id, `${label}.id`);
		if (seenIds.has(id)) {
			throw new LocationInputError(`${manifestPath} contains duplicate query id ${id}.`);
		}
		seenIds.add(id);
		return {
			expectedReferenceId:
				row.expectedReferenceId === null || row.expected_reference_id === null
					? null
					: requireNonEmptyString(
							row.expectedReferenceId ?? row.expected_reference_id,
							`${label}.expectedReferenceId`,
						),
			file: requireNonEmptyString(row.file, `${label}.file`),
			id,
			mimeType:
				row.mimeType === undefined
					? inferMediaMimeType(row.file)
					: requireMediaMimeType(row.mimeType, label),
		};
	});
}

export async function loadLocationQueryManifest(manifestPath) {
	const absoluteManifestPath = path.resolve(manifestPath);
	const value = await readFile(absoluteManifestPath, "utf8");
	const queries = parseLocationQueryManifest(value, { manifestPath: absoluteManifestPath });
	return queries.map((query) => ({
		...query,
		filePath: path.resolve(path.dirname(absoluteManifestPath), query.file),
	}));
}

export async function fingerprintLocationMedia(filePath) {
	const bytes = await readFile(filePath);
	return {
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

function parseLocationReference(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new LocationInputError(`${label} must be an object.`);
	}
	const id = requireNonEmptyString(value.id, `${label}.id`);
	const file = requireNonEmptyString(value.file, `${label}.file`);
	const floor = requireNonEmptyString(value.location?.floor, `${label}.location.floor`);
	const x = requireFiniteNumber(value.location?.x, `${label}.location.x`);
	const y = requireFiniteNumber(value.location?.y, `${label}.location.y`);
	const z =
		value.location?.z === undefined
			? undefined
			: requireFiniteNumber(value.location.z, `${label}.location.z`);
	const mimeType =
		value.mimeType === undefined
			? inferMediaMimeType(file)
			: requireMediaMimeType(value.mimeType, label);
	return {
		file,
		id,
		label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : id,
		location: z === undefined ? { floor, x, y } : { floor, x, y, z },
		mimeType,
	};
}
