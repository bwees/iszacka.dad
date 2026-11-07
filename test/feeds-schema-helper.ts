// A deliberately small JSON Schema checker for the subset our schemas use (type, enum,
// const, properties, required, additionalProperties, items, minimum, maximum, $ref).
// Lets the tests prove that MCP output schemas and OpenAPI schemas describe real output.

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
	return typeof value;
}

function typeMatches(expected: string, actual: string): boolean {
	return expected === actual || (expected === 'number' && actual === 'integer');
}

/** Returns a list of problems; empty means valid. */
export function validate(value: unknown, schema: Schema, root: Schema = schema, path = '$'): string[] {
	if (typeof schema.$ref === 'string') {
		const target = schema.$ref
			.replace(/^#\//, '')
			.split('/')
			.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], root);
		if (!target || typeof target !== 'object') return [`${path}: unresolved $ref ${schema.$ref}`];
		return validate(value, target as Schema, root, path);
	}
	const problems: string[] = [];
	const actual = typeOf(value);
	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
		if (!types.some((t) => typeMatches(t, actual))) return [`${path}: expected ${types.join('|')}, got ${actual}`];
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) problems.push(`${path}: ${JSON.stringify(value)} not in enum`);
	if ('const' in schema && schema.const !== value) problems.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
	if (typeof value === 'number') {
		if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push(`${path}: below minimum`);
		if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push(`${path}: above maximum`);
	}
	if (actual === 'object') {
		const obj = value as Record<string, unknown>;
		const props = (schema.properties ?? {}) as Record<string, Schema>;
		for (const key of (schema.required ?? []) as string[]) if (!(key in obj)) problems.push(`${path}: missing ${key}`);
		for (const [key, child] of Object.entries(obj)) {
			if (props[key]) problems.push(...validate(child, props[key], root, `${path}.${key}`));
			else if (schema.additionalProperties === false) problems.push(`${path}: unexpected ${key}`);
			else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
				problems.push(...validate(child, schema.additionalProperties as Schema, root, `${path}.${key}`));
			}
		}
	}
	if (actual === 'array' && schema.items && typeof schema.items === 'object') {
		(value as unknown[]).forEach((item, i) => problems.push(...validate(item, schema.items as Schema, root, `${path}[${i}]`)));
	}
	return problems;
}
