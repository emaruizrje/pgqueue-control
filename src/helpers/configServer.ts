export type QueueBackend = 'pgboss' | 'absurd';

export class ServerConfig {
    readonly databaseUrl: string;
    readonly queueBackend: QueueBackend;
    readonly port: number;

    constructor() {
        if (!process.env.DATABASE_URL) {
            throw new Error('DATABASE_URL is not defined in environment variables');
        }
        this.databaseUrl = process.env.DATABASE_URL;

        const backend = process.env.QUEUE_BACKEND ?? 'pgboss';
        if (backend !== 'pgboss' && backend !== 'absurd') {
            throw new Error(`Unknown QUEUE_BACKEND "${backend}" (expected pgboss|absurd)`);
        }
        this.queueBackend = backend;

        this.port = Number(process.env.PORT ?? 4400);
    }
}