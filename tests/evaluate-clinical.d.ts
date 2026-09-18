// `scripts/**` is plain Node and not covered by allowJs, so the one export
// tests/initialStation.test.ts imports from it is typed by hand here.
declare module '*evaluate-clinical.mjs' {
  export function main(argv?: string[]): Promise<number>;
}
