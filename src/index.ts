#!/usr/bin/env node

import { existsSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { exit } from 'process';
import * as Arborist from '@npmcli/arborist';
import { Command } from 'commander';
import { Packument } from 'pacote';
import { createLogger, format as loggerFormat, transports as loggerTransports } from 'winston';
import { Config, ExitCode, Node, Validation } from './types';
import { buildFlatDependencies, processDependencies, validateDependencies } from './utils';

const program = new Command();

program
  .argument('<path>', 'Path to project directory')
  .option('-a, --allow <allow>', 'Comma separated list of allowed packages with version spec (<package>@<spec>)')
  .option('-d, --deny <deny>', 'Comma separated list of denied packages with version spec (<package>@<spec>)')
  .option('-e, --exclude <exclude>', 'Comma separated list of exclude packages from validating')
  .option('-i, --include <include>', 'Comma separated list of include packages from validating')
  .option('-m, --minDays <days>', 'Minimum days after publish')
  .option('-j, --json', 'Display output as JSON')
  .option('-u, --unsafe', 'Return only unsafe packages')
  .option('--debug', 'Show debug messages')
  .option('--includeDev', 'Include development dependencies for validation')
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
        includeDev: resource.includeDev,
        json: resource.json,
        minDays: resource.minDays,
        unsafe: resource.unsafe,
      };
    } catch (exception) {
      logger.error('Cannot import resource file');
      logger.debug(exception);

      exit(ExitCode.ERROR);
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

  if (options.includeDev != null) {
    config.includeDev = true;
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

  const hasLockFile = existsSync(resolvePath(path, 'package-lock.json'));
  const hasNodeModules = existsSync(resolvePath(path, 'node_modules'));

  if (!hasLockFile && !hasNodeModules) {
    logger.error('Cannot find "package-lock.json" file or "node_modules" folder in specified directory');

    exit(ExitCode.ERROR);
  }

  let tree: Node;

  (config.json ?? false) === false && logger.info('Start loading dependency list...');

  const arborist = new Arborist({ path });

  if (hasLockFile) {
    tree = await arborist.loadVirtual();
  } else {
    tree = await arborist.loadActual();
  }

  const dependencies = buildFlatDependencies(tree, config);

  (config.json ?? false) === false && logger.info('Retrieving packages metadata...');

  let packuments: Packument[];

  try {
    packuments = await processDependencies(dependencies, config);
  } catch (exception) {
    logger.error(`Error while retrieving packages metadata: ${(exception as Error).message}`);
    logger.debug(exception);

    exit(ExitCode.ERROR);
  }

  (config.json ?? false) === false && logger.info('Validate dependencies...');

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

      fullSafe = fullSafe && valid.safe;
    }

    console.log(JSON.stringify(data));
  } else {
    for (const [name, { daysSincePublish, safe }] of validation) {
      if (safe) {
        if (config.unsafe !== true) {
          logger.info(`Package ${name} is safe`);
        }
      } else {
        logger.warn(`Package ${name} is not safe (${daysSincePublish} day(s) since last publish)`);
      }

      fullSafe = fullSafe && safe;
    }
  }

  exit(fullSafe ? ExitCode.OK : ExitCode.FAIL);
})();
