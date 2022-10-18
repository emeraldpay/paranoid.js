#!/usr/bin/env node

import { existsSync } from 'fs';
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
  .option('-a, --allow <allow>', 'comma separated list of allowed packages with version spec (<package>@<spec>)')
  .option('-d, --deny <deny>', 'comma separated list of denied packages with version spec (<package>@<spec>)')
  .option('-e, --exclude <exclude>', 'comma separated list of exclude packages from validating')
  .option('-i, --include <include>', 'comma separated list of include packages from validating')
  .option('-m, --minDays <days>', 'minimum days after publish (default 14)')
  .option('-j, --json', 'display output as JSON')
  .option('-u, --unsafe', 'return only unsafe packages')
  .option('--debug', 'show debug messages')
  .option('--excludeDev', 'exclude development dependencies for validation (ignored for Yarn projects only)')
  .parse();

const [path] = program.args;
const options = program.opts();

const logger = createLogger({
  format: loggerFormat.combine(loggerFormat.colorize(), loggerFormat.simple()),
  level: options.debug ? 'debug' : 'info',
  transports: [new loggerTransports.Console()],
});

(async () => {
  const resourcePath = resolvePath(path, '.paranoidrc.js');

  let config: Config = {};

  if (existsSync(resourcePath)) {
    try {
      const resource: Config = await import(resourcePath);

      config = {
        allow: resource.allow,
        deny: resource.deny,
        exclude: resource.exclude,
        include: resource.include,
        excludeDev: resource.excludeDev,
        json: resource.json,
        minDays: resource.minDays,
        unsafe: resource.unsafe,
      };
    } catch (exception) {
      logger.error('Cannot import resource file');
      logger.debug(exception);

      process.exit(ExitCode.ERROR);
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
