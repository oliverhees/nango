import fs from 'fs';
import { glob } from 'glob';
import * as tsNode from 'ts-node';
import chalk from 'chalk';
import path from 'path';
import { build } from 'tsup';

import { getNangoRootPath, printDebug, slash } from '../utils.js';
import { loadYamlAndGenerate } from './model.service.js';
import parserService from './parser.service.js';
import type { NangoYamlParsed, ScriptFileType, ScriptTypeLiteral } from '@nangohq/types';
import { getProviderConfigurationFromPath } from '@nangohq/nango-yaml';

const ALLOWED_IMPORTS = ['url', 'crypto', 'zod', 'node:url', 'node:crypto', 'botbuilder', 'soap', 'unzipper'];

export async function compileAllFiles({
    debug,
    fullPath,
    scriptName,
    providerConfigKey,
    type
}: {
    debug: boolean;
    fullPath: string;
    scriptName?: string;
    providerConfigKey?: string;
    type?: ScriptFileType;
}): Promise<boolean> {
    const tsconfig = fs.readFileSync(path.join(getNangoRootPath(), 'tsconfig.dev.json'), 'utf8');

    const distDir = path.join(fullPath, 'dist');
    if (!fs.existsSync(distDir)) {
        if (debug) {
            printDebug(`Creating ${distDir} directory`);
        }
        fs.mkdirSync(distDir);
    }

    const parsed = loadYamlAndGenerate({ fullPath, debug });
    if (!parsed) {
        return false;
    }

    const compilerOptions = (JSON.parse(tsconfig) as { compilerOptions: Record<string, any> }).compilerOptions;
    const compiler = tsNode.create({
        skipProject: true, // when installed locally we don't want ts-node to pick up the package tsconfig.json file
        compilerOptions
    });

    if (debug) {
        printDebug(`Compiler options: ${JSON.stringify(compilerOptions, null, 2)}`);
    }

    let scriptDirectory: string | undefined;
    if (scriptName && providerConfigKey && type) {
        scriptDirectory = resolveTsFileLocation({ fullPath, scriptName, providerConfigKey, type }).replace(fullPath, '');
        console.log(chalk.green(`Compiling ${scriptName}.ts in ${fullPath}${scriptDirectory}`));
    }

    const integrationFiles = listFilesToCompile({ scriptName, fullPath, scriptDirectory, parsed, debug, providerConfigKey });
    let success = true;

    for (const file of integrationFiles) {
        try {
            const completed = await compile({ fullPath, file, parsed, compiler, debug });
            if (completed === false) {
                return false;
            }
        } catch (err) {
            console.log(chalk.red(`Error compiling "${file.inputPath}":`));
            console.error(err);
            success = false;
        }
    }

    return success;
}

export async function compileSingleFile({
    fullPath,
    file,
    parsed,
    tsconfig,
    debug = false
}: {
    fullPath: string;
    file: ListedFile;
    tsconfig?: string;
    parsed: NangoYamlParsed;
    debug: boolean;
}) {
    const resolvedTsconfig = tsconfig ?? fs.readFileSync(path.join(getNangoRootPath(), 'tsconfig.dev.json'), 'utf8');

    try {
        const compiler = tsNode.create({
            skipProject: true, // when installed locally we don't want ts-node to pick up the package tsconfig.json file
            compilerOptions: JSON.parse(resolvedTsconfig).compilerOptions
        });

        const result = await compile({
            fullPath,
            file,
            parsed,
            compiler,
            debug
        });

        return result === true;
    } catch (err) {
        console.error(`Error compiling ${file.inputPath}:`);
        console.error(err);
        return false;
    }
}

function compileImportedFile({
    fullPath,
    filePath,
    compiler,
    parsed,
    type
}: {
    fullPath: string;
    filePath: string;
    compiler: tsNode.Service;
    parsed: NangoYamlParsed;
    type: ScriptTypeLiteral | undefined;
}): boolean {
    let finalResult = true;
    const importedFiles = parserService.getImportedFiles(filePath);

    if (!parserService.callsAreUsedCorrectly(filePath, type, Array.from(parsed.models.keys()))) {
        return false;
    }

    for (const importedFile of importedFiles) {
        const importedFilePath = path.resolve(path.dirname(filePath), importedFile);
        const importedFilePathWithoutExtension = path.join(path.dirname(importedFilePath), path.basename(importedFilePath, path.extname(importedFilePath)));
        const importedFilePathWithExtension = importedFilePathWithoutExtension + '.ts';

        /// if it is a library import then we can skip it
        if (!fs.existsSync(importedFilePathWithExtension)) {
            // if the library is not allowed then we should let the user know
            // that it is not allowed and won't work early on
            if (!ALLOWED_IMPORTS.includes(importedFile)) {
                console.log(chalk.red(`Importing libraries is not allowed. Please remove the import "${importedFile}" from "${path.basename(filePath)}"`));
                return false;
            }
            continue;
        }

        // if the file is not in the nango-integrations directory
        // then we should not compile it
        // if the parts of the path are shorter than the current that means it is higher
        // than the nango-integrations directory
        if (importedFilePathWithExtension.split(path.sep).length < fullPath.split(path.sep).length) {
            const importedFileName = path.basename(importedFilePathWithExtension);

            console.log(
                chalk.red(
                    `All imported files must live within the nango-integrations directory. Please move "${importedFileName}" into the nango-integrations directory.`
                )
            );
            return false;
        }

        if (importedFilePathWithExtension.includes('models.ts')) {
            continue;
        }

        compiler.compile(fs.readFileSync(importedFilePathWithExtension, 'utf8'), importedFilePathWithExtension);
        console.log(chalk.green(`Compiled "${importedFilePathWithExtension}" successfully`));

        finalResult = compileImportedFile({ fullPath, filePath: importedFilePathWithExtension, compiler, type, parsed });
    }

    return finalResult;
}

async function compile({
    fullPath,
    file,
    parsed,
    compiler,
    debug = false
}: {
    fullPath: string;
    file: ListedFile;
    parsed: NangoYamlParsed;
    compiler: tsNode.Service;
    debug: boolean;
}): Promise<boolean | null> {
    const providerConfiguration = getProviderConfigurationFromPath({ filePath: file.inputPath, parsed });
    if (!providerConfiguration) {
        return null;
    }

    const syncConfig = [...providerConfiguration.syncs, ...providerConfiguration.actions].find((sync) => sync.name === file.baseName);
    const type = syncConfig?.type || 'sync';

    const success = compileImportedFile({ fullPath, filePath: file.inputPath, compiler, type, parsed });
    if (!success) {
        return false;
    }

    compiler.compile(fs.readFileSync(file.inputPath, 'utf8'), file.inputPath);

    const dirname = path.dirname(file.outputPath);
    const extname = path.extname(file.outputPath);
    const basename = path.basename(file.outputPath, extname);

    const fileNameWithExtension = `${basename}-${providerConfiguration.providerConfigKey}${extname}`;
    const outputPath = path.join(dirname, fileNameWithExtension);

    if (debug) {
        printDebug(`Compiling ${file.inputPath} -> ${outputPath}`);
    }

    await build({
        entryPoints: [slash(file.inputPath)], // tsup needs posix paths
        tsconfig: path.join(getNangoRootPath(), 'tsconfig.dev.json'),
        skipNodeModulesBundle: true,
        silent: !debug,
        outDir: path.join(fullPath, 'dist'),
        outExtension: () => ({ js: '.js' }),
        onSuccess: async () => {
            if (fs.existsSync(file.outputPath)) {
                try {
                    await fs.promises.rename(file.outputPath, outputPath);
                    // eslint-disable-next-line no-empty
                } catch {}
            }
        }
    });

    return true;
}

export interface ListedFile {
    inputPath: string;
    outputPath: string;
    baseName: string;
}

export function getFileToCompile({ fullPath, filePath }: { fullPath: string; filePath: string }): ListedFile {
    const baseName = path.basename(filePath, '.ts');
    return {
        inputPath: filePath,
        outputPath: path.join(fullPath, 'dist', `${baseName}.js`),
        baseName
    };
}

export function resolveTsFileLocation({
    fullPath,
    scriptName,
    providerConfigKey,
    type
}: {
    fullPath: string;
    scriptName: string;
    providerConfigKey: string;
    type: ScriptFileType;
}): string {
    const nestedPath = path.resolve(fullPath, providerConfigKey, type, `${scriptName}.ts`);
    if (fs.existsSync(nestedPath)) {
        return fs.realpathSync(path.resolve(nestedPath, '../'));
    }

    return fs.realpathSync(path.join(fullPath, './'));
}

export function listFilesToCompile({
    fullPath,
    scriptDirectory,
    scriptName,
    parsed,
    debug,
    providerConfigKey
}: {
    fullPath: string;
    scriptDirectory?: string | undefined;
    scriptName?: string | undefined;
    parsed: NangoYamlParsed;
    debug?: boolean;
    providerConfigKey?: string | undefined;
}): ListedFile[] {
    let files: string[] = [];

    // Compiling a specific script
    if (scriptName) {
        if (debug) {
            printDebug(`Compiling script: ${scriptName}.ts`);
        }
        files = [path.join(fullPath, scriptDirectory || '', `${scriptName}.ts`)];
    }
    // Filtering by providerConfigKey or compiling all files
    else {
        // Always include models.ts
        const modelsPath = path.join(fullPath, 'models.ts');
        if (fs.existsSync(modelsPath)) {
            files = [modelsPath];
        } else {
            files = [];
        }

        // If not filtering by provider, include all root TypeScript files
        if (!providerConfigKey) {
            const rootFiles = globFiles(fullPath, '*.ts').filter((file) => path.basename(file) !== 'models.ts');
            files.push(...rootFiles);

            if (debug && rootFiles.length > 0) {
                printDebug(`Found ${rootFiles.length} TypeScript files in the root directory`);
            }
        }
        const filteredIntegrations = providerConfigKey
            ? parsed.integrations.filter((integration) => integration.providerConfigKey === providerConfigKey)
            : parsed.integrations;

        if (providerConfigKey && debug) {
            if (filteredIntegrations.length > 0) {
                printDebug(`Compiling file(s) for integration: ${providerConfigKey}`);
            } else {
                printDebug(`Warning: No '${providerConfigKey}' integration found`);
            }
        }

        for (const integration of filteredIntegrations) {
            // Look for files in each script type directory
            const scriptTypes: ScriptFileType[] = ['syncs', 'actions', 'on-events', 'post-connection-scripts'];
            for (const scriptType of scriptTypes) {
                const scriptPath = `${integration.providerConfigKey}/${scriptType}`;
                const scriptFiles = globFiles(fullPath, scriptPath, '*.ts');
                if (scriptFiles.length > 0 && debug) {
                    printDebug(`Found ${scriptFiles.length} files in ${scriptPath}`);
                }
                files.push(...scriptFiles);
            }
        }
    }

    return files.map((filePath) => {
        return getFileToCompile({ fullPath, filePath });
    });
}

function globFiles(...args: string[]): string[] {
    // glob.sync needs posix paths for input, so use slash fn
    return glob.sync(slash(path.join(...args)));
}
