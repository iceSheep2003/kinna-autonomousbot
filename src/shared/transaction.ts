/** 同一个同步提交范围；禁止在回调里 await 网络调用。 */
export interface UnitOfWork { run<T>(commit: () => T): T }
export type Commit = () => void;
