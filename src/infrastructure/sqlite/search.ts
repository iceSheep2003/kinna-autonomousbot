export function searchTerms(query: string): string[] {
  const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  return terms.flatMap(term => term.length > 3 ? [term, term.slice(0, 2)] : [term]);
}
export function matchSql(terms: string[]): string {
  return terms.map(() => "instr(lower(json_extract(body,'$.content')),?)>0").join(' OR ');
}
