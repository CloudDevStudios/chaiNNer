import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { app } from 'electron';
import path from 'path';
import { getBackend } from '../../common/Backend';
import { PythonInfo } from '../../common/common-types';
import { sanitizedEnv } from '../../common/env';
import { log } from '../../common/log';

const backendPath = app.isPackaged
    ? path.join(process.resourcesPath, 'src', 'run.py')
    : './backend/src/run.py';

interface BaseBackendProcess {
    readonly owned: boolean;
    readonly port: number;
    readonly python: PythonInfo;
}

type Env = Readonly<Partial<Record<string, string>>>;

type ErrorListener = (error: Error) => void;

export class OwnedBackendProcess implements BaseBackendProcess {
    readonly owned = true;

    readonly port: number;

    readonly python: PythonInfo;

    private readonly env: Env;

    private process?: ChildProcessWithoutNullStreams;

    private errorListeners: ErrorListener[] = [];

    private constructor(
        port: number,
        python: PythonInfo,
        env: Env,
        process: ChildProcessWithoutNullStreams
    ) {
        this.port = port;
        this.python = python;
        this.env = env;
        this.setNewProcess(process);
    }

    static spawn(port: number, python: PythonInfo, env: Env = {}): OwnedBackendProcess {
        // defensive copy
        // eslint-disable-next-line no-param-reassign
        env = { ...env };

        const backend = OwnedBackendProcess.spawnProcess(port, python, env);
        return new OwnedBackendProcess(port, python, env, backend);
    }

    private static spawnProcess(
        port: number,
        { python }: PythonInfo,
        env: Env
    ): ChildProcessWithoutNullStreams {
        log.info('Attempting to spawn backend...');

        const backend = spawn(python, [backendPath, String(port)], {
            env: {
                ...sanitizedEnv,
                ...env,
            },
        });

        const removedTrailingNewLine = (s: string) => s.replace(/\r?\n$/, '');
        backend.stdout.on('data', (data) => {
            const dataString = String(data);
            // Remove unneeded timestamp
            const fixedData = dataString.split('] ').slice(1).join('] ');
            log.info(`Backend: ${removedTrailingNewLine(fixedData)}`);
        });
        backend.stderr.on('data', (data) => {
            log.error(`Backend: ${removedTrailingNewLine(String(data))}`);
        });

        return backend;
    }

    addErrorListener(listener: ErrorListener) {
        this.errorListeners.push(listener);
    }

    private setNewProcess(process: ChildProcessWithoutNullStreams): void {
        this.process = process;

        process.on('error', (error) => {
            log.error(`Python subprocess encountered an unexpected error: ${String(error)}`);

            for (const listener of this.errorListeners) {
                listener(error);
            }
        });
        process.on('exit', (code, signal) => {
            log.error(
                `Python subprocess exited with code ${String(code)} and signal ${String(signal)}`
            );

            if (this.process === process) {
                // reset process
                this.process = undefined;
            }
        });
    }

    /**
     * Kills the current backend process.
     *
     * @throws If the backend process could n
     */
    kill() {
        log.info('Attempting to kill backend...');

        if (!this.process) {
            // No process to kill
            log.warn('Process has already been killed');
            return;
        }
        if (this.process.exitCode !== null) {
            // process was killed by something on the outside and we missed it
            log.warn('Process has already been killed');
            this.process = undefined;
            return;
        }

        if (this.process.kill()) {
            this.process = undefined;
            log.info('Successfully killed backend.');
        } else {
            throw new Error('Unable to the backend process. Kill returned false.');
        }
    }

    /**
     * Tries to kill the backend.
     *
     * This function is guaranteed to throw no errors, it will only log errors if any occur.
     */
    tryKill() {
        try {
            this.kill();
        } catch (error) {
            log.error('Error killing backend.', error);
        }
    }

    restart() {
        this.tryKill();

        const backend = OwnedBackendProcess.spawnProcess(this.port, this.python, this.env);
        this.setNewProcess(backend);
    }
}

export class BorrowedBackendProcess implements BaseBackendProcess {
    readonly owned = false;

    readonly port: number;

    readonly python: PythonInfo;

    private constructor(port: number, python: PythonInfo) {
        this.port = port;
        this.python = python;
    }

    static async fromPort(port: number): Promise<BorrowedBackendProcess> {
        const backend = getBackend(port);
        const python = await backend.pythonInfo();
        return new BorrowedBackendProcess(port, python);
    }
}

export type BackendProcess = OwnedBackendProcess | BorrowedBackendProcess;
