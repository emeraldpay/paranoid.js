#!/usr/bin/env node

import { existsSync, statSync as pathStat } from 'fs';
import { resolve as resolvePath } from 'path';
import * as process from 'process';
import * as Arborist from '@npmcli/arborist';
import { Command } from 'commander';
import { Packument } from 'pacote';
import { createLogger, format as loggerFormat, transports as loggerTransports } from 'winston';
import { Config, ExitCode, Node, Validation } from './types';
import {
  buildFlatDependencies,
  loadYarnLockfileDependencies,
  processDependencies,
  validateDependencies,
} from './utils';

const program = new Command();

program
  .argument('<path>', 'path to project directory')
  .option('-c, --config <path>', 'Specify path to config file')
  .option('-a, --allow <allow>', 'comma separated list of allowed packages with version spec (<package>@<spec>)')
  .option('-d, --deny <deny>', 'comma separated list of denied packages with version spec (<package>@<spec>)')
  .option('-e, --exclude <exclude>', 'comma separated list of exclude packages from validating')
  .option('-i, --include <include>', 'comma separated list of include packages from validating')
  .option('-m, --minDays <days>', 'minimum days after publish (default 14)')
  .option('-j, --json', 'display output as JSON')
  .option('-u, --unsafe', 'return only unsafe packages')
  .option('--debug', 'show debug messages')
  .option('--excludeDev', 'exclude development dependencies for validation (ignored for Yarn projects only)')
  .option('--ignoreConfig', 'Ignore all options from config file')
  .option('--ignoreOptions <options>', 'Comma separated list of options to ignore from config file')
  .parse();

const [path] = program.args;
const options = program.opts();

const logger = createLogger({
  format: loggerFormat.combine(loggerFormat.colorize(), loggerFormat.simple()),
  level: options.debug ? 'debug' : 'info',
  transports: [new loggerTransports.Console()],
});

(async () => {
  let config: Config = {};

  if (options.ignoreConfig == null) {
    let configPath: string | undefined;

    if (options.config == null) {
      const projectConfigPath = resolvePath(path, '.paranoidrc.js');

      if (existsSync(projectConfigPath)) {
        configPath = projectConfigPath;
      }
    } else {
      const optionConfigPath = resolvePath(options.config);

      if (existsSync(optionConfigPath) && pathStat(optionConfigPath).isFile()) {
        configPath = optionConfigPath;
      } else {
        logger.error('Cannot find specified config file');

        process.exit(ExitCode.ERROR);
      }
    }

    if (configPath != null) {
      try {
        const configData: Config = await import(configPath);

        config = {
          allow: configData.allow,
          deny: configData.deny,
          exclude: configData.exclude,
          include: configData.include,
          excludeDev: configData.excludeDev,
          json: configData.json,
          minDays: configData.minDays,
          unsafe: configData.unsafe,
        };
      } catch (exception) {
        logger.error('Cannot read config file');
        logger.debug(exception);

        process.exit(ExitCode.ERROR);
      }
    }

    if (options.ignoreOptions != null) {
      const ignoredOptions: string[] = options.ignoreOptions.split(',').map((option: string) => option.trim());

      if (ignoredOptions.length > 0) {
        config = Object.keys(config).reduce<Config>((carry, option) => {
          if (ignoredOptions.includes(option)) {
            return carry;
          }

          return {
            ...carry,
            [option]: config[option as keyof Config],
          };
        }, {});
      }
    }
  }

  if (options.allow != null) {
    config.allow = new Map(
      options.allow
        .trim()
        .split(',')
        .map((allow: string) =>
          allow
            .trim()
            .split('@')
            .map((item: string) => item.trim()),
        ),
    );
  }

  if (options.deny != null) {
    config.deny = new Map(
      options.deny
        .trim()
        .split(',')
        .map((deny: string) =>
          deny
            .trim()
            .split('@')
            .map((item: string) => item.trim()),
        ),
    );
  }

  if (options.exclude != null) {
    config.exclude = options.exclude
      .trim()
      .split(',')
      .map((exclude: string) => exclude.trim());
  }

  if (options.include != null) {
    config.include = options.include
      .trim()
      .split(',')
      .map((include: string) => include.trim());
  }

  if (options.excludeDev != null) {
    config.excludeDev = true;
  }

  if (options.json != null) {
    config.json = true;
  }

  if (options.minDays != null) {
    const days = parseInt(options.minDays, 10);

    config.minDays = isNaN(days) ? undefined : days;
  }

  if (options.unsafe != null) {
    config.unsafe = true;
  }

  const yarnLockfilePath = resolvePath(path, 'yarn.lock');

  const hasNpmLockfile = existsSync(resolvePath(path, 'package-lock.json'));
  const hasNodeModules = existsSync(resolvePath(path, 'node_modules'));
  const hasYarnLockfile = existsSync(yarnLockfilePath);

  !(config.json ?? false) && logger.info('Start loading dependency list...');

  let dependencies: Map<string, Set<string>>;

  if (hasNpmLockfile || (hasNodeModules && !hasYarnLockfile)) {
    const arborist = new Arborist({ path });

    let tree: Node;

    if (hasNpmLockfile) {
      tree = await arborist.loadVirtual();
    } else {
      tree = await arborist.loadActual();
    }

    dependencies = buildFlatDependencies(tree, config);
  } else if (hasYarnLockfile) {
    dependencies = await loadYarnLockfileDependencies(yarnLockfilePath);
  } else {
    logger.error('Cannot find "package-lock.json" file or "node_modules" folder in specified directory');

    process.exit(ExitCode.ERROR);
  }

  !(config.json ?? false) && logger.info('Retrieving packages metadata...');

  let packuments: Packument[];

  try {
    packuments = await processDependencies(dependencies, config);
  } catch (exception) {
    logger.error(`Error while retrieving packages metadata: ${(exception as Error).message}`);
    logger.debug(exception);

    process.exit(ExitCode.ERROR);
  }

  !(config.json ?? false) && logger.info('Validate dependencies...');

  const validation = validateDependencies(dependencies, packuments, config);

  let fullSafe = true;

  if (config.json === true) {
    const data: Record<string, Validation> = {};

    for (const [name, valid] of validation) {
      if (valid.safe) {
        if (config.unsafe !== true) {
          data[name] = valid;
        }
      } else {
        data[name] = valid;
      }

      fullSafe &&= valid.safe;
    }

    console.log(JSON.stringify(data));
  } else {
    for (const [name, { daysSincePublish, safe, version }] of validation) {
      if (safe) {
        if (config.unsafe !== true) {
          logger.info(`Package ${name}@${version} is safe`);
        }
      } else {
        logger.warn(`Package ${name}@${version} is not safe (${daysSincePublish} day(s) since last publish)`);
      }

      fullSafe &&= safe;
    }
  }

  process.exit(fullSafe ? ExitCode.OK : ExitCode.FAIL);
})();
