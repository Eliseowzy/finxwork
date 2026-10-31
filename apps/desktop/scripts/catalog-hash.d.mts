export declare const catalogSkillsDir: string;
export declare function skillHash(dir: string): { sha256: string; files: number };
export declare function catalogProblems(entries: { id: string; sha256: string; files: number }[]): string[];
