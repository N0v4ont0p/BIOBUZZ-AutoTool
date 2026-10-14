export function basename(filePath: string | null | undefined): string {
  return filePath?.split(/[\\/]/).pop() ?? "";
}

export function stripPpExtension(name: string | null | undefined): string {
  return (name ?? "").replace(/\.pp$/, "");
}

export function pathStem(filePath: string | null | undefined): string {
  return stripPpExtension(basename(filePath));
}
