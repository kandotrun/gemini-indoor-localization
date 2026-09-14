export const LOCATION_EMBEDDING_MODEL = "gemini-embedding-2";
export const LOCATION_EMBEDDING_DIMENSIONS = 3072;
export const DIRECT_EMBEDDING_ENDPOINT =
	"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent";
export const DEFAULT_TOP_K = 5;
export const DEFAULT_MIN_SCORE = 0.65;
export const DEFAULT_MIN_MARGIN = 0.04;
export const DEFAULT_MAX_INLINE_BYTES = 20 * 1024 * 1024;

export const MIME_TYPES_BY_EXTENSION = new Map([
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".png", "image/png"],
	[".mov", "video/quicktime"],
	[".mp4", "video/mp4"],
]);
export const SUPPORTED_MEDIA_MIME_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"video/mp4",
	"video/quicktime",
]);
