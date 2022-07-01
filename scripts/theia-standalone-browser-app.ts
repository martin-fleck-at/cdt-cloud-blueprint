/********************************************************************************
 * Copyright (C) 2022 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
import { spawn, spawnSync } from "child_process";
import * as fs from "fs-extra";
import { glob } from "glob";
import * as path from "path";
import yargs from "yargs/yargs";
const waitPort = require("wait-port");

interface Disposable {
    dispose(): void;
}

const args = yargs(process.argv)
    .option('app', { alias: 'a', type: 'string', default: 'applications/browser', description: 'The application package that should be built. All local dependencies must be present in the include pattern.' })
    .option('output', { alias: 'o', type: 'string', default: '../target/', description: 'The output directory for the build result.' })
    .option('includeExtensions', { alias: 'i', type: 'array', default: ['theia-extensions/*'], description: 'An array of glob patterns matching all extensions that should be published.' })
    .option('excludeExtensions', { alias: 'e', type: 'array', default: [], description: 'An array of glob patterns matching all extensions that should be ignored for publishing.' })
    .option('verdaccioConfig', { alias: 'c', type: 'string', default: 'configs/verdaccio.config.yaml', desription: 'The configuration of the temporary Verdaccio instance.' })
    .option('verdaccioPort', { alias: 'p', type: 'number', default: 4873, description: 'Port on which the temporary Verdaccio instance should be run.' })
    .option('verdaccioStorage', { alias: 's', type: 'string', default: 'verdaccio-storage', description: 'The directory name where the temporary Verdaccio instance should be stored.' })
    .option('debug', { alias: 'd', type: 'boolean', default: false, nargs: 0, description: 'Enable debug output' })
    .help('h').alias('h', 'help')
    .version(false)
    .wrap(120)
    .parse();

execute();

async function execute(): Promise<void> {
    const disposables: Disposable[] = [];
    const cleanup = () => disposables.forEach(disposable => disposable.dispose());
    process.addListener('SIGINT', () => cleanup());

    const target = args.output.endsWith('/') ? args.output : args.output + '/';
    const registry = `http://localhost:${args.verdaccioPort}`;

    if (args.debug) {
        console.log('Configuration', { ...args, registry });
    }

    try {
        disposables.push(await startVerdaccio(args.verdaccioConfig, args.verdaccioPort, args.verdaccioStorage, args.debug));
        disposables.push(await createNpmrcFile(registry));
        await publishExtensions(registry, args.includeExtensions, args.excludeExtensions, args.debug);
        await copyApp(args.app, target);
        await adaptApp(target);
        await buildApp(target, registry, args.debug);
        await minifyApp(target, args.debug);
        console.log(`🏁 You can start the app with: cd ${target} && node ./node_modules/@theia/cli/bin/theia start`)
    } finally {
        cleanup();
    }
}

async function createNpmrcFile(registry: string): Promise<Disposable> {
    console.log('📝 Generating npmrc file...');
    const path = '.npmrc';
    let cleanup: () => void;
    if (fs.existsSync(path)) {
        // restore previous content if file already exists
        const originalContent = fs.readFileSync(path);
        cleanup = () => fs.writeFileSync(path, originalContent);
    } else {
        cleanup = () => fs.removeSync(path);
    }
    fs.writeFileSync(path, `${registry.replace('http:', '')}/:_authToken="fooBar"\n`);
    return { dispose: () => cleanup() }
}

async function startVerdaccio(config: string, port: number, storage: string, debug: boolean): Promise<Disposable> {
    const verdaccioWorkingDir = path.resolve(storage);
    const configCmd = config ? `--config ${config}` : '';
    const portCmd = port ? `--listen ${port}` : '';
    const args = `${configCmd} ${portCmd}`.split(' ');

    console.log('🚀 Starting verdaccio...');
    const stdio = debug ? 'inherit' : undefined;
    const verdaccioHandle = spawn(
        'verdaccio',
        args,
        {
            stdio,
            env: {
                ...process.env,
                VERDACCIO_STORAGE_PATH: verdaccioWorkingDir
            }
        }
    );
    await waitPort({ port });
    return {
        dispose: () => {
            verdaccioHandle.kill();
            fs.removeSync(verdaccioWorkingDir);
        }
    };
}

async function publishExtensions(registry: string, includeExtensionPaths: string[], ignoreExtensionPaths: string[], debug: boolean): Promise<void> {
    const paths: string[] = [];
    for (const includeExtensionPath of includeExtensionPaths) {
        const result = glob.sync(includeExtensionPath, { ignore: ignoreExtensionPaths, realpath: true });
        paths.push(...result);
    }
    const uniquePaths = [...new Set(paths)];
    for (const extensionPath of uniquePaths) {
        const version = require(extensionPath + '/package.json').version;
        console.log(`🪛  Publishing version ${version} of '${extensionPath}'...`);
        await executeProcess('yarn', ['publish', '--registry', registry, '--new-version', version], extensionPath, debug);
    }
}

async function copyApp(app: string, target: string): Promise<void> {
    console.log(`🚡 Copying app from '${app}' to '${target}'...`);
    await fs.removeSync(target);
    await fs.copySync(app, target, { recursive: true, overwrite: true });
    await fs.copyFileSync('yarn.lock', target + 'yarn.lock');
}

async function adaptApp(target: string): Promise<void> {
    // ensure we also consider root-level resolutions configuration
    console.log(`🖊️  Adapting app in '${target}'...`);
    const rootPackageJson = await fs.readJSONSync('package.json');
    if (rootPackageJson.resolutions) {
        const appPackageJson = await fs.readJSONSync(target + 'package.json');
        appPackageJson.resolutions = { ...appPackageJson.resolutions, ...rootPackageJson.resolutions };
        await fs.writeJSONSync(target + 'package.json', appPackageJson)
    }
}

async function buildApp(target: string, registry: string, debug: boolean): Promise<void> {
    console.log(`🏗️  Building app from '${target}'... (this may take several minutes)`);
    await executeProcess('yarn', ['install', '--registry', registry, '--network-timeout', '100000'], target, debug);
    console.log(`📦 Building app completed successfully at '${target}'.`);
}

async function minifyApp(target: string, debug: boolean): Promise<void> {
    console.log(`🔬  Minifying built app in '${target}'`);
    await executeProcess('yarn', ['autoclean', '--init'], target, debug);
    await executeProcess('yarn', ['autoclean', '--force'], target, debug);
}

async function executeProcess(command: string, args: string[], target: string, debug: boolean): Promise<void> {
    const stdio = debug ? 'inherit' : undefined;
    const process = await spawnSync(command, args, { stdio, cwd: target });
    if (process.signal) {
        throw new Error(`Aborted.`);
    }
    if (process.error) {
        console.log(`Error encountered.`);
        throw process.error;
    }
}