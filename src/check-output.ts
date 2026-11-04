// What a failed check on a pull request gives the Coding agent: its name and the end of its output, where it says what went wrong.
const OUTPUT_BYTES = 4096;

function lastBytes(text: string, max: number): string {
	const bytes = Buffer.from(text, 'utf8');
	if (bytes.length <= max) return text;
	let start = bytes.length - max;
	// never begin inside a multi-byte character
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
	return bytes.subarray(start).toString('utf8');
}

export function failedCheckBody(name: string, output: string): string {
	return output.trim() === '' ? name : `${name}\n\n${lastBytes(output, OUTPUT_BYTES)}`;
}
