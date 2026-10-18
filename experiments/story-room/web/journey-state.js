/** Preserve witnessed lines when rapid gameplay replaces an unsent state update. */
export function mergeSnapshots(previous, incoming) {
 if(!previous || previous.session!==incoming.session) return incoming;
 const rows=new Map([...previous.observations,...incoming.observations].map(row=>[row.id,row]));
 return {...incoming,observations:[...rows.values()].slice(-80)};
}
