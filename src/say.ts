// How the command speaks: its own lines, and what a fault says.

export const say = (line: string) => console.log(`nightjar: ${line}`);

export const why = (fault: unknown) => (fault instanceof Error ? fault.message : String(fault));
