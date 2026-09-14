export class LocationInputError extends Error {
	constructor(message) {
		super(message);
		this.name = "LocationInputError";
	}
}

export class LocationEmbeddingError extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "LocationEmbeddingError";
	}
}

export function assertFiniteVector(values, label) {
	if (
		!Array.isArray(values) ||
		values.length === 0 ||
		values.some((value) => !Number.isFinite(value))
	) {
		throw new LocationInputError(`${label} must be a non-empty finite vector.`);
	}
}
export function requireNonEmptyString(value, label) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new LocationInputError(`${label} must be a non-empty string.`);
	}
	return value.trim();
}
export function requireFiniteNumber(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new LocationInputError(`${label} must be a finite number.`);
	}
	return value;
}
export function requireMediaMimeType(value, label) {
	if (typeof value !== "string" || !SUPPORTED_MEDIA_MIME_TYPES.has(value)) {
		throw new LocationInputError(
			`${label}.mimeType must be image/jpeg, image/png, video/mp4, or video/quicktime.`,
		);
	}
	return value;
}
export function requireValue(args, index, optionName) {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new LocationInputError(`${optionName} requires a value.`);
	}
	return value;
}
export function parsePositiveInteger(value, optionName) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new LocationInputError(`${optionName} must be a positive integer.`);
	}
	return parsed;
}
export function parseBoundedNumber(value, optionName, min, max) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
		throw new LocationInputError(`${optionName} must be between ${min} and ${max}.`);
	}
	return parsed;
}
import { SUPPORTED_MEDIA_MIME_TYPES } from "./constants.mjs";
