/**
 * Ambient type declarations for @earendil-works/pi-ai (optional peer dep).
 */

declare module "@earendil-works/pi-ai" {
	/**
	 * Create a StringEnum type for use with TypeBox schemas.
	 * @param values - Tuple of allowed string values
	 * @param options - Optional description
	 */
	export function StringEnum<T extends readonly string[]>(
		values: T,
		options?: { description?: string },
	): import("typebox").TStringEnum<T[number]>;
}
