#!/usr/bin/env node

import { existsSync, statSync as pathStat } from 'fs';
import { resolve as resolvePath } from 'path';
import * as process from 'process';
import * as Arborist from '@npmcli/arborist';
import * as Calculator from '@npmcli/metavuln-calculator';
import { Command } from 'commander';
import * as fetch from 'npm-registry-fetch';
import { Packument } from 'pacote';
import { createLogger, format as loggerFormat, transports as loggerTransports } from 'winston';
import { Advisory, Config, Dependency, ExitCode, Node, Validation } from './types';
import {
  buildFlatDependencies,
  loadYarnLockfileDependencies,
  processDependencies,
  validateDependencies,
} from './utils';

const program = new Command();

program
  .argument('<path>', 'path to project directory')
  .option('-c, --config <path>', 'use specified path to config file')
  .option('-a, --allow <allow>', 'comma separated list of allowed packages with version spec (<package>@<spec>)')
  .option('-d, --deny <deny>', 'comma separated list of denied packages with version spec (<package>@<spec>)')
  .option('-e, --exclude <exclude>', 'comma separated list of exclude packages from validating')
  .option('-i, --include <include>', 'comma separated list of include packages from validating')
  .option('-m, --minDays <days>', 'minimum days after publish (default 14)')
  .option('-j, --json', 'display output as JSON')
  .option('-p, --production', 'if it possible, then check specified version from lock file')
  .option('-u, --unsafe', 'return only unsafe packages')
  .option('--debug', 'show debug messages')
  .option('--excludeDev', 'exclude development dependencies for validation (ignored for Yarn projects only)')
  .option('--ignoreConfig', 'ignore config file, even if used specified path')
  .option('--ignoreOptions <options>', 'comma separated list of options to ignore from config file')
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
          minDays: configData.minDays,
          json: configData.json,
          production: configData.production,
          unsafe: configData.unsafe,
          excludeDev: configData.excludeDev,
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

  if (options.minDays != null) {
    const days = parseInt(options.minDays, 10);

    config.minDays = isNaN(days) ? undefined : days;
  }

  if (options.json != null) {
    config.json = true;
  }

  if (options.production != null) {
    config.production = true;
  }

  if (options.unsafe != null) {
    config.unsafe = true;
  }

  if (options.excludeDev != null) {
    config.excludeDev = true;
  }

  const yarnLockfilePath = resolvePath(path, 'yarn.lock');

  const hasNpmLockfile = existsSync(resolvePath(path, 'package-lock.json'));
  const hasNodeModules = existsSync(resolvePath(path, 'node_modules'));
  const hasYarnLockfile = existsSync(yarnLockfilePath);

  !(config.json ?? false) && logger.info('Start loading dependency list...');

  let dependencies: Map<string, Dependency>;

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

  const vulnerabilities = new Map<string, Advisory[]>();

  try {
    const request = await fetch('/-/npm/v1/security/advisories/bulk', {
      body: Object.fromEntries(
        [...dependencies].reduce<Array<[string, Array<string>]>>(
          (carry, [name, { versions }]) => [...carry, [name, [...versions]]],
          [],
        ),
      ),
      gzip: true,
      method: 'POST',
    });

    const advisories: Record<string, unknown[]> = await request.json();

    const calculator = new Calculator();

    for (const [name, items] of Object.entries(advisories)) {
      for (const item of items) {
        const advisory = await calculator.calculate(name, item);

        const vulnerability = vulnerabilities.get(name) ?? [];

        vulnerability.push(advisory);

        vulnerabilities.set(name, vulnerability);
      }
    }
  } catch (exception) {
    logger.warn(`Cannot get security advisories: ${(exception as Error).message}`);
    logger.debug(exception);
  }

  const validations = validateDependencies(dependencies, packuments, vulnerabilities, config);

  let fullSafe = true;

  if (config.json === true) {
    const data: Record<string, Validation[]> = {};

    for (const [name, items] of validations) {
      data[name] = config.unsafe === true ? items.filter((validation) => !validation.safe) : items;

      fullSafe &&= items.reduce((carry, validation) => carry && validation.safe, true);
    }

    console.log(JSON.stringify(data));
  } else {
    for (const [name, items] of validations) {
      for (const { daysSincePublish, recommendations, safe, version } of items) {
        if (recommendations.length > 0) {
          logger.warn(`Package ${name}@${version} is not safe:`);

          for (const [index, { dependency, fixedVersion, range, severity, title, url }] of recommendations.entries()) {
            if (recommendations.length > 1) {
              logger.warn(`\t-- ${index + 1} of ${recommendations.length} --`);
            }

            if (dependency !== name) {
              logger.warn(`\tDependency "${dependency}" is vulnerable`);
            }

            logger.warn(`\tDescription: ${title}`);
            logger.warn(`\tHas a ${severity} severity, check ${url} for more details`);
            logger.warn(`\tVersions ${range} is affected, install version ${fixedVersion}`);
          }
        } else if (safe) {
          if (config.unsafe !== true) {
            logger.info(`Package ${name}@${version} is safe`);
          }
        } else {
          logger.warn(`Package ${name}@${version} is not safe (${daysSincePublish} day(s) since last publish)`);
        }

        fullSafe &&= safe;
      }
    }
  }

  process.exit(fullSafe ? ExitCode.OK : ExitCode.FAIL);
})();
