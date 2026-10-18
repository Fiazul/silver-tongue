export function mergeSnapshots<T extends {session:string;observations:{id:string}[]}>(previous:T|null,incoming:T):T;
