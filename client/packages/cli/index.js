// @ts-check

import version from "./src/version.js";
import { mkdir, writeFile, readFile, stat } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import chalk from "chalk";
import { program, Option } from "commander";
import { input, confirm, select } from "@inquirer/prompts";
import envPaths from "env-paths";
import { loadConfig } from "unconfig";
import { packageDirectory } from "pkg-dir";
import openInBrowser from "open";
import ora from "ora";
import terminalLink from "terminal-link";
import { exec } from "child_process";
import { promisify } from "util";
import {
  detectPackageManager,
  getInstallCommand,
} from "./src/util/packageManager.js";
import { pathExists, readJsonFile } from "./src/util/fs.js";

const execAsync = promisify(exec);

// config
dotenv.config();

const dev = Boolean(process.env.INSTANT_CLI_DEV);
const verbose = Boolean(process.env.INSTANT_CLI_VERBOSE);

// logs

function warn(firstArg, ...rest) {
  console.warn(chalk.yellow("[warning]") + " " + firstArg, ...rest);
}

function error(firstArg, ...rest) {
  console.error(chalk.red("[error]") + " " + firstArg, ...rest);
}

// consts

const potentialEnvs = {
  catchall: "INSTANT_APP_ID",
  next: "NEXT_PUBLIC_INSTANT_APP_ID",
  svelte: "PUBLIC_INSTANT_APP_ID",
  vite: "VITE_INSTANT_APP_ID",
};

const noAppIdErrorMessage = `
Couldn't find an app ID.

You can either: 
a. Set ${chalk.green("`INSTANT_APP_ID`")} in your .env file. [1]
b. Or provide an app ID via the CLI: ${chalk.green("`instant-cli push|pull -a <app-id>`")}.

[1] Alternatively, If you have ${chalk.green("`NEXT_PUBLIC_INSTANT_APP_ID`")}, ${chalk.green("`VITE_INSTANT_APP_ID`")}, we can detect those too!
`.trim();

const instantDashOrigin = dev
  ? "http://localhost:3000"
  : "https://instantdb.com";

const instantBackendOrigin =
  process.env.INSTANT_CLI_API_URI ||
  (dev ? "http://localhost:8888" : "https://api.instantdb.com");

const PUSH_PULL_OPTIONS = new Set(["schema", "perms", "all"]);

function convertArgToBagWithErrorLogging(arg) {
  if (!arg) {
    return { ok: true, bag: "all" };
  } else if (PUSH_PULL_OPTIONS.has(arg.trim().lowercase())) {
    return { ok: true, bag: arg };
  } else {
    error(
      `${chalk.red(arg)} must be one of ${chalk.green(Array.from(PUSH_PULL_OPTIONS).join(", "))}`,
    );
    return { ok: false };
  }
}

// Note: Nov 20, 2024
// We can eventually deprecate this
// once we're confident that users no longer
// provide app ID as their first argument
function convertPushPullToCurrentFormat(cmdName, arg, opts) {
  if (arg && !PUSH_PULL_OPTIONS.has(arg) && !opts.app) {
    warnDeprecation(`${cmdName} ${arg}`, `${cmdName} --app ${arg}`);
    return { ok: true, bag: "all", opts: { ...opts, app: arg } };
  }
  const { ok, bag } = convertArgToBagWithErrorLogging(arg);
  if (!ok) return { ok: false };
  return { ok: true, bag, opts };
}

async function packageDirectoryWithErrorLogging() {
  const pkgDir = await packageDirectory();
  if (!pkgDir) {
    error("Couldn't find your root directory. Is there a package.json file?");
    return;
  }
  return pkgDir;
}

// cli

// Header -- this shows up in every command
const logoChalk = chalk.bold("instant-cli");
const versionChalk = chalk.dim(`${version.trim()}`);
const headerChalk = `${logoChalk} ${versionChalk} ` + "\n";

// Help Footer -- this only shows up in help commands
const helpFooterChalk =
  "\n" +
  chalk.dim.bold("Want to learn more?") +
  "\n" +
  `Check out the docs: ${chalk.blueBright.underline("https://instantdb.com/docs")}
Join the Discord:   ${chalk.blueBright.underline("https://discord.com/invite/VU53p7uQcE")}
`.trim();

program.addHelpText("after", helpFooterChalk);

program.addHelpText("beforeAll", headerChalk);

function getLocalAndGlobalOptions(cmd, helper) {
  const mixOfLocalAndGlobal = helper.visibleOptions(cmd);
  const localOptionsFromMix = mixOfLocalAndGlobal.filter(
    (option) => !option.__global,
  );
  const globalOptionsFromMix = mixOfLocalAndGlobal.filter(
    (option) => option.__global,
  );
  const globalOptions = helper.visibleGlobalOptions(cmd);

  return [localOptionsFromMix, globalOptionsFromMix.concat(globalOptions)];
}

// custom `formatHelp`
// original: https://github.com/tj/commander.js/blob/master/lib/help.js
function formatHelp(cmd, helper) {
  const termWidth = helper.padWidth(cmd, helper);
  const helpWidth = helper.helpWidth || 80;
  const itemIndentWidth = 2;
  const itemSeparatorWidth = 2; // between term and description
  function formatItem(term, description) {
    if (description) {
      const fullText = `${term.padEnd(termWidth + itemSeparatorWidth)}${description}`;
      return helper.wrap(
        fullText,
        helpWidth - itemIndentWidth,
        termWidth + itemSeparatorWidth,
      );
    }
    return term;
  }
  function formatList(textArray) {
    return textArray.join("\n").replace(/^/gm, " ".repeat(itemIndentWidth));
  }

  // Usage
  let output = [`${helper.commandUsage(cmd)}`, ""];

  // Description
  const commandDescription = helper.commandDescription(cmd);
  if (commandDescription.length > 0) {
    output = output.concat([helper.wrap(commandDescription, helpWidth, 0), ""]);
  }

  // Arguments
  const argumentList = helper.visibleArguments(cmd).map((argument) => {
    return formatItem(
      helper.argumentTerm(argument),
      helper.argumentDescription(argument),
    );
  });
  if (argumentList.length > 0) {
    output = output.concat([
      chalk.dim.bold("Arguments"),
      formatList(argumentList),
      "",
    ]);
  }
  const [visibleOptions, visibleGlobalOptions] = getLocalAndGlobalOptions(
    cmd,
    helper,
  );

  // Options
  const optionList = visibleOptions.map((option) => {
    return formatItem(
      helper.optionTerm(option),
      helper.optionDescription(option),
    );
  });
  if (optionList.length > 0) {
    output = output.concat([
      chalk.dim.bold("Options"),
      formatList(optionList),
      "",
    ]);
  }
  // Commands
  const commandList = helper.visibleCommands(cmd).map((cmd) => {
    return formatItem(
      helper.subcommandTerm(cmd),
      helper.subcommandDescription(cmd),
    );
  });
  if (commandList.length > 0) {
    output = output.concat([
      chalk.dim.bold("Commands"),
      formatList(commandList),
      "",
    ]);
  }

  if (this.showGlobalOptions) {
    const globalOptionList = visibleGlobalOptions.map((option) => {
      return formatItem(
        helper.optionTerm(option),
        helper.optionDescription(option),
      );
    });
    if (globalOptionList.length > 0) {
      output = output.concat([
        chalk.dim.bold("Global Options"),
        formatList(globalOptionList),
        "",
      ]);
    }
  }

  return output.join("\n");
}

program.configureHelp({
  showGlobalOptions: true,
  formatHelp,
});

function globalOption(flags, description, argParser) {
  const opt = new Option(flags, description);
  if (argParser) {
    opt.argParser(argParser);
  }
  // @ts-ignore
  // __global does not exist on `Option`,
  // but we use it in `getLocalAndGlobalOptions`, to produce
  // our own custom list of local and global options.
  // For more info, see the original PR:
  // https://github.com/instantdb/instant/pull/505
  opt.__global = true;
  return opt;
}

function warnDeprecation(oldCmd, newCmd) {
  warn(
    chalk.yellow("`instant-cli " + oldCmd + "` is deprecated.") +
      " Use " +
      chalk.green("`instant-cli " + newCmd + "`") +
      " instead." +
      "\n",
  );
}

program
  .name("instant-cli")
  .addOption(globalOption("-t --token <token>", "Auth token override"))
  .addOption(globalOption("-y --yes", "Answer 'yes' to all prompts"))
  .addOption(
    globalOption("-v --version", "Print the version number", () => {
      console.log(version);
      process.exit(0);
    }),
  )
  .addHelpOption(globalOption("-h --help", "Print the help text for a command"))
  .usage(`<command> ${chalk.dim("[options] [args]")}`);

program
  .command("login")
  .description("Log into your account")
  .option("-p --print", "Prints the auth token into the console.")
  .action(login);

program
  .command("init")
  .description("Set up a new project.")
  .option(
    "-a --app <app-id>",
    "If you have an existing app ID, we can pull schema and perms from there.",
  )
  .action(async function (opts) {
    await handlePull("all", opts);
  });

// Note: Nov 20, 2024
// We can eventually delete this,
// once we know most people use the new pull and push commands
program
  .command("push-schema", { hidden: true })
  .argument("[app-id]")
  .description("Push schema to production.")
  .option(
    "--skip-check-types",
    "Don't check types on the server when pushing schema",
  )
  .action(async (appIdOrName, opts) => {
    warnDeprecation("push-schema", "push schema");
    await handlePush("schema", { app: appIdOrName, ...opts });
  });

// Note: Nov 20, 2024
// We can eventually delete this,
// once we know most people use the new pull and push commands
program
  .command("push-perms", { hidden: true })
  .argument("[app-id]")
  .description("Push perms to production.")
  .action(async (appIdOrName) => {
    warnDeprecation("push-perms", "push perms");
    await handlePush("perms", { app: appIdOrName });
  });

program
  .command("push")
  .argument(
    "[schema|perms|all]",
    "Which configuration to push. Defaults to `all`",
  )
  .option(
    "-a --app <app-id>",
    "App ID to push too. Defaults to *_INSTANT_APP_ID in .env",
  )
  .option(
    "--skip-check-types",
    "Don't check types on the server when pushing schema",
  )
  .description("Push schema and perm files to production.")
  .action(async function (arg, inputOpts) {
    const ret = convertPushPullToCurrentFormat("push", arg, inputOpts);
    if (!ret.ok) return;
    const { bag, opts } = ret;
    await handlePush(bag, opts);
  });

// Note: Nov 20, 2024
// We can eventually delete this,
// once we know most people use the new pull and push commands
program
  .command("pull-schema", { hidden: true })
  .argument("[app-id]")
  .description("Generate instant.schema.ts from production")
  .action(async (appIdOrName) => {
    warnDeprecation("pull-schema", "pull schema");
    await handlePull("schema", { app: appIdOrName });
  });

// Note: Nov 20, 2024
// We can eventually delete this,
// once we know most people use the new pull and push commands
program
  .command("pull-perms", { hidden: true })
  .argument("[app-id]")
  .description("Generate instant.perms.ts from production.")
  .action(async (appIdOrName) => {
    warnDeprecation("pull-perms", "pull perms");
    await handlePull("perms", { app: appIdOrName });
  });

program
  .command("pull")
  .argument(
    "[schema|perms|all]",
    "Which configuration to push. Defaults to `all`",
  )
  .option(
    "-a --app <app-id>",
    "App ID to push to. Defaults to *_INSTANT_APP_ID in .env",
  )
  .description("Pull schema and perm files from production.")
  .action(async function (arg, inputOpts) {
    const ret = convertPushPullToCurrentFormat("pull", arg, inputOpts);
    if (!ret.ok) return;
    const { bag, opts } = ret;
    await handlePull(bag, opts);
  });

program.parse(process.argv);

// command actions
async function handlePush(bag, opts) {
  const { ok, appId } = await detectOrCreateAppWithErrorLogging(opts);
  if (!ok) return;
  await push(bag, appId, opts);
}

async function push(bag, appId, opts) {
  if (bag === "schema" || bag === "all") {
    const ok = await pushSchema(appId, opts);
    if (!ok) return;
  }
  if (bag === "perms" || bag === "all") {
    await pushPerms(appId);
  }
}

async function handlePull(bag, opts) {
  const pkgAndAuthInfo = await resolvePackageAndAuthInfoWithErrorLogging();
  if (!pkgAndAuthInfo) return;
  const { ok, appId, appTitle, isCreated } =
    await detectOrCreateAppWithErrorLogging(opts);
  if (!ok) return;
  if (isCreated) {
    await handleCreatedApp(pkgAndAuthInfo, appId, appTitle);
  } else {
    await pull(bag, appId, pkgAndAuthInfo);
  }
}

async function pull(bag, appId, pkgAndAuthInfo) {
  if (bag === "schema" || bag === "all") {
    const ok = await pullSchema(appId, pkgAndAuthInfo);
    if (!ok) return;
  }
  if (bag === "perms" || bag === "all") {
    await pullPerms(appId, pkgAndAuthInfo);
  }
}

async function login(options) {
  const registerRes = await fetchJson({
    method: "POST",
    path: "/dash/cli/auth/register",
    debugName: "Login register",
    errorMessage: "Failed to register login.",
    noAuth: true,
  });

  if (!registerRes.ok) return;

  const { secret, ticket } = registerRes.data;
  console.log("Let's log you in!");
  const ok = await promptOk(
    `This will open instantdb.com in your browser, OK to proceed?`,
  );

  if (!ok) return;

  openInBrowser(`${instantDashOrigin}/dash?ticket=${ticket}`);

  console.log("Waiting for authentication...");
  const authTokenRes = await waitForAuthToken({ secret });
  if (!authTokenRes) {
    return;
  }

  const { token, email } = authTokenRes;

  if (options.print) {
    console.log(chalk.red("[Do not share] Your Instant auth token:", token));
  } else {
    await saveConfigAuthToken(token);
    console.log(chalk.green(`Successfully logged in as ${email}!`));
  }
}

async function getOrInstallInstantModuleWithErrorLogging(pkgDir) {
  const pkgJson = await getPackageJSONWithErrorLogging(pkgDir);
  if (!pkgJson) {
    return;
  }
  console.log("Checking for an Instant SDK...");
  const instantModuleName = await getInstantModuleName(pkgJson);
  if (instantModuleName) {
    console.log(
      `Found ${chalk.green(instantModuleName)} in your package.json.`,
    );
    return instantModuleName;
  }
  console.log(
    "Couldn't find an Instant SDK in your package.json, let's install one!",
  );
  const moduleName = await select({
    message: "Which package would you like to use?",
    choices: [
      { name: "@instantdb/react", value: "@instantdb/react" },
      { name: "@instantdb/react-native", value: "@instantdb/react-native" },
      { name: "@instantdb/core", value: "@instantdb/core" },
      { name: "@instantdb/admin", value: "@instantdb/admin" },
    ],
  });

  const packageManager = await detectPackageManager(pkgDir);
  const installCommand = getInstallCommand(packageManager, moduleName);

  const spinner = ora(
    `Installing ${moduleName} using ${packageManager}...`,
  ).start();

  try {
    await execAsync(installCommand, pkgDir);
    spinner.succeed(`Installed ${moduleName} using ${packageManager}.`);
  } catch (e) {
    spinner.fail(`Failed to install ${moduleName} using ${packageManager}.`);
    error(e.message);
    return;
  }

  return moduleName;
}

async function createApp({ pkgDir, instantModuleName }) {
  const schema = await readLocalSchemaFile();
  const { perms } = await readLocalPermsFile();

  const id = randomUUID();
  const token = randomUUID();
  const _title = await input({
    message: "What would you like to call it?",
    default: "My cool app",
    required: true,
  }).catch(() => null);

  const title = _title?.trim();

  if (!title) {
    error("No name provided. Exiting.");
    return;
  }

  const appRes = await fetchJson({
    method: "POST",
    path: "/dash/apps",
    debugName: "App create",
    errorMessage: "Failed to create app.",
    body: { id, title, admin_token: token },
  });

  if (!appRes.ok) return;

  console.log(chalk.green(`Successfully created your Instant app "${title}"`));
  console.log(`Please add your app ID to your .env config:`);
  console.log(chalk.magenta(`INSTANT_APP_ID=${id}`));
  console.log(chalk.underline(appDashUrl(id)));

  if (!schema) {
    const schemaPath = join(pkgDir, "instant.schema.ts");
    await writeFile(
      schemaPath,
      instantSchemaTmpl(title, id, instantModuleName),
      "utf-8",
    );
    console.log("Start building your schema: " + schemaPath);
  }

  if (!perms) {
    await writeFile(
      join(pkgDir, "instant.perms.ts"),
      examplePermsTmpl,
      "utf-8",
    );
  }
}

async function promptForAppId(pkgAndAuthInfo) {
  const res = await fetchJson({
    debugName: "Fetching apps",
    method: "GET",
    path: "/dash",
    errorMessage: "Failed to fetch apps.",
  });
  if (!res.ok) {
    return;
  }
  const { apps } = res.data;
  if (!apps.length) {
    const ok = await promptOk(
      "You don't have any apps. Want to create a new one?",
    );
    if (!ok) return;
    await createApp(pkgAndAuthInfo);
    return;
  }
  const choice = await select({
    message: "Which app would you like to import?",
    choices: res.data.apps.map((app) => {
      return { name: `${app.title} (${app.id})`, value: app.id };
    }),
  });
  if (!choice) return;
  return choice;
}

async function promptCreateApp() {
  const id = randomUUID();
  const token = randomUUID();
  const _title = await input({
    message: "What would you like to call it?",
    default: "My cool app",
    required: true,
  }).catch(() => null);

  const title = _title?.trim();

  if (!title) {
    error("No name provided. Exiting.");
    return { ok: false };
  }
  const app = { id, title, admin_token: token };
  const appRes = await fetchJson({
    method: "POST",
    path: "/dash/apps",
    debugName: "App create",
    errorMessage: "Failed to create app.",
    body: app,
  });

  if (!appRes.ok) return { ok: false };
  return {
    ok: true,
    appId: id,
    appTitle: title,
    isCreated: true,
  };
}

async function promptImportAppOrCreateApp() {
  const res = await fetchJson({
    debugName: "Fetching apps",
    method: "GET",
    path: "/dash",
    errorMessage: "Failed to fetch apps.",
  });
  if (!res.ok) {
    return { ok: false };
  }
  const { apps } = res.data;
  if (!apps.length) {
    const ok = await promptOk(
      "You don't have any apps. Want to create a new one?",
    );
    if (!ok) return { ok: false };
    return await promptCreateApp();
  }
  const choice = await select({
    message: "Which app would you like to import?",
    choices: res.data.apps.map((app) => {
      return { name: `${app.title} (${app.id})`, value: app.id };
    }),
  }).catch(() => null);
  if (!choice) return { ok: false };
  return { ok: true, appId: choice };
}

async function detectOrCreateAppWithErrorLogging(opts) {
  const fromOpts = await detectAppIdFromOptsWithErrorLogging(opts);
  if (!fromOpts.ok) return fromOpts;
  if (fromOpts.appId) {
    return { ok: true, appId: fromOpts.appId };
  }

  const fromEnv = detectAppIdFromEnvWithErrorLogging();
  if (!fromEnv.ok) return fromEnv;
  if (fromEnv.found) {
    const { envName, value } = fromEnv.found;
    console.log(`Found ${chalk.green(envName)}: ${value}`);
    return { ok: true, appId: value };
  }

  const action = await select({
    message: "What would you like to do?",
    choices: [
      { name: "Create a new app", value: "create" },
      { name: "Import an existing app", value: "import" },
    ],
  }).catch(() => null);

  if (action === "create") {
    return await promptCreateApp();
  }

  return await promptImportAppOrCreateApp();
}

async function handleCreatedApp(
  { pkgDir, instantModuleName },
  appId,
  appTitle,
) {
  const schema = await readLocalSchemaFile();
  const { perms } = await readLocalPermsFile();

  console.log(chalk.green(`Successfully created your Instant app "${appId}"`));
  console.log(`Please add your app ID to your .env config:`);
  console.log(chalk.magenta(`INSTANT_APP_ID=${appId}`));
  console.log(terminalLink("Dashboard", appDashUrl(appId)));

  if (!schema) {
    const schemaPath = join(pkgDir, "instant.schema.ts");
    await writeFile(
      schemaPath,
      instantSchemaTmpl(appTitle, appId, instantModuleName),
      "utf-8",
    );
    console.log("Start building your schema: " + schemaPath);
  }

  if (!perms) {
    await writeFile(
      join(pkgDir, "instant.perms.ts"),
      examplePermsTmpl,
      "utf-8",
    );
  }
}

async function getInstantModuleName(pkgJson) {
  const deps = pkgJson.dependencies || {};
  const instantModuleName = [
    "@instantdb/react",
    "@instantdb/react-native",
    "@instantdb/core",
    "@instantdb/admin",
  ].find((name) => deps[name]);
  return instantModuleName;
}

async function getPackageJSONWithErrorLogging(pkgDir) {
  const pkgJson = await readJsonFile(join(pkgDir, "package.json"));
  if (!pkgJson) {
    error(`Couldn't find a packge.json file in: ${pkgDir}. Please add one.`);
    return;
  }
  return pkgJson;
}

async function resolvePackageAndAuthInfoWithErrorLogging() {
  const pkgDir = await packageDirectoryWithErrorLogging();
  if (!pkgDir) {
    return;
  }
  const instantModuleName =
    await getOrInstallInstantModuleWithErrorLogging(pkgDir);
  if (!instantModuleName) {
    return;
  }
  const authToken = await readConfigAuthTokenWithErrorLogging();
  if (!authToken) {
    return;
  }
  return { pkgDir, instantModuleName, authToken };
}

async function pullSchema(appId, { pkgDir, instantModuleName }) {
  console.log("Pulling schema...");

  const pullRes = await fetchJson({
    path: `/dash/apps/${appId}/schema/pull`,
    debugName: "Schema pull",
    errorMessage: "Failed to pull schema.",
  });

  if (!pullRes.ok) return;

  const hasEnvFile = await pathExists(join(pkgDir, ".env"));
  if (!hasEnvFile) {
    const ok = await promptOk(
      "No .env file detected, would you like to create one so you can push updates to schema and perms?",
    );

    if (ok) {
      await writeFile(join(pkgDir, ".env"), `INSTANT_APP_ID=${appId}`, "utf-8");
      console.log(
        `Created .env file with INSTANT_APP_ID=${appId} in ${pkgDir}`,
      );
    } else {
      console.log(
        "No .env file created. If you plan to push updates, please create one.",
      );
    }
  }

  if (
    !countEntities(pullRes.data.schema.refs) &&
    !countEntities(pullRes.data.schema.blobs)
  ) {
    console.log("Schema is empty. Skipping.");
    return;
  }

  const hasSchemaFile = await pathExists(join(pkgDir, "instant.schema.ts"));
  if (hasSchemaFile) {
    const ok = await promptOk(
      "This will overwrite your local instant.schema file, OK to proceed?",
    );

    if (!ok) return;
  }

  const schemaPath = join(pkgDir, "instant.schema.ts");
  await writeFile(
    schemaPath,
    generateSchemaTypescriptFile(
      appId,
      pullRes.data.schema,
      pullRes.data["app-title"],
      instantModuleName,
    ),
    "utf-8",
  );

  console.log("Wrote schema to instant.schema.ts");

  return true;
}

async function pullPerms(appId, { pkgDir }) {
  console.log("Pulling perms...");

  const pullRes = await fetchJson({
    path: `/dash/apps/${appId}/perms/pull`,
    debugName: "Perms pull",
    errorMessage: "Failed to pull perms.",
  });

  if (!pullRes.ok) return;

  if (!pullRes.data.perms || !countEntities(pullRes.data.perms)) {
    console.log("No perms.  Exiting.");
    return;
  }

  if (await pathExists(join(pkgDir, "instant.perms.ts"))) {
    const ok = await promptOk(
      "This will ovwerwrite your local instant.perms file, OK to proceed?",
    );

    if (!ok) return;
  }

  const permsPath = join(pkgDir, "instant.perms.ts");
  await writeFile(
    permsPath,
    `export default ${JSON.stringify(pullRes.data.perms, null, "  ")};`,
    "utf-8",
  );

  console.log("Wrote permissions to instant.perms.ts");

  return true;
}

function indexingJobCompletedActionMessage(job) {
  if (job.job_type === "check-data-type") {
    return `setting type of ${job.attr_name} to ${job.checked_data_type}`;
  }
  if (job.job_type === "remove-data-type") {
    return `removing type from ${job.attr_name}`;
  }
  if (job.job_type === "index") {
    return `adding index to ${job.attr_name}`;
  }
  if (job.job_type === "remove-index") {
    return `removing index from ${job.attr_name}`;
  }
  if (job.job_type === "unique") {
    return `adding uniqueness constraint to ${job.attr_name}`;
  }
  if (job.job_type === "remove-unique") {
    return `removing uniqueness constraint from ${job.attr_name}`;
  }
}

function truncate(s, maxLen) {
  if (s.length > maxLen) {
    return `${s.substr(0, maxLen - 3)}...`;
  }
  return s;
}

function formatSamples(triples_samples) {
  return triples_samples.slice(0, 3).map((t) => {
    return { ...t, value: truncate(JSON.stringify(t.value), 32) };
  });
}

function indexingJobCompletedMessage(job) {
  const actionMessage = indexingJobCompletedActionMessage(job);
  if (job.job_status === "canceled") {
    return `Canceled ${actionMessage} before it could finish.`;
  }
  if (job.job_status === "completed") {
    return `Finished ${actionMessage}.`;
  }
  if (job.job_status === "errored") {
    if (job.invalid_triples_sample?.length) {
      const [etype, label] = job.attr_name.split(".");
      const samples = formatSamples(job.invalid_triples_sample);
      const longestValue = samples.reduce(
        (acc, { value }) => Math.max(acc, value.length),
        // Start with length of label
        label.length,
      );

      let msg = `${chalk.red("INVALID DATA")} ${actionMessage}.\n`;
      if (job.invalid_unique_value) {
        msg += `  Found multiple entities with value ${truncate(JSON.stringify(job.invalid_unique_value), 64)}.\n`;
      }
      if (job.error === "triple-too-large-error") {
        msg += `  Some of the existing data is too large to index.\n`;
      }
      msg += `  First few examples:\n`;
      msg += `  ${chalk.bold("id")}${" ".repeat(35)}| ${chalk.bold(label)}${" ".repeat(longestValue - label.length)} | ${chalk.bold("type")}\n`;
      msg += `  ${"-".repeat(37)}|${"-".repeat(longestValue + 2)}|--------\n`;
      for (const triple of samples) {
        const urlParams = new URLSearchParams({
          s: "main",
          app: job.app_id,
          t: "explorer",
          ns: etype,
          where: JSON.stringify(["id", triple.entity_id]),
        });
        const url = new URL(instantDashOrigin);
        url.pathname = "/dash";
        url.search = urlParams.toString();

        const link = terminalLink(triple.entity_id, url.toString(), {
          fallback: () => triple.entity_id,
        });
        msg += `  ${link} | ${triple.value}${" ".repeat(longestValue - triple.value.length)} | ${triple.json_type}\n`;
      }
      return msg;
    }
    return `Error ${actionMessage}.`;
  }
}

function joinInSentence(items) {
  if (items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return items[0];
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function jobGroupDescription(jobs) {
  const actions = new Set();
  const jobActions = {
    "check-data-type": "updating types",
    "remove-data-type": "updating types",
    index: "updating indexes",
    "remove-index": "updating indexes",
    unique: "updating uniqueness constraints",
    "remove-unique": "updating uniqueness constraints",
  };
  for (const job of jobs) {
    actions.add(jobActions[job.job_type]);
  }
  return joinInSentence([...actions].sort()) || "updating schema";
}

async function waitForIndexingJobsToFinish(appId, data) {
  const spinner = ora({
    text: "checking data types",
  }).start();
  const groupId = data["group-id"];
  let jobs = data.jobs;
  let waitMs = 20;
  let lastUpdatedAt = new Date(0);

  const completedIds = new Set();

  const completedMessages = [];
  const errorMessages = [];

  while (true) {
    let stillRunning = false;
    let updated = false;
    let workEstimateTotal = 0;
    let workCompletedTotal = 0;

    for (const job of jobs) {
      const updatedAt = new Date(job.updated_at);
      if (updatedAt > lastUpdatedAt) {
        updated = true;
        lastUpdatedAt = updatedAt;
      }
      if (job.job_status === "waiting" || job.job_status === "processing") {
        stillRunning = true;
        // Default estimate to high value to prevent % from jumping around
        workEstimateTotal += job.work_estimate ?? 50000;
        workCompletedTotal += job.work_completed ?? 0;
      } else {
        if (!completedIds.has(job.id)) {
          completedIds.add(job.id);
          const msg = indexingJobCompletedMessage(job);
          if (job.job_status === "errored") {
            errorMessages.push(msg);
          } else {
            completedMessages.push(msg);
          }
        }
      }
    }
    if (!stillRunning) {
      break;
    }
    if (workEstimateTotal) {
      const percent = Math.floor(
        (workCompletedTotal / workEstimateTotal) * 100,
      );
      spinner.text = `${jobGroupDescription(jobs)} ${percent}%`;
    }
    if (completedMessages.length) {
      spinner.prefixText = completedMessages.join("\n") + "\n";
    }
    waitMs = updated ? 1 : Math.min(10000, waitMs * 2);
    await sleep(waitMs);
    const res = await fetchJson({
      debugName: "Check indexing status",
      method: "GET",
      path: `/dash/apps/${appId}/indexing-jobs/group/${groupId}`,
      errorMessage: "Failed to check indexing status.",
    });
    if (!res.ok) {
      break;
    }
    jobs = res.data.jobs;
  }
  spinner.stopAndPersist({
    text: "",
    prefixText: completedMessages.join("\n"),
  });

  // Log errors at the end so that they're easier to see.
  if (errorMessages.length) {
    for (const msg of errorMessages) {
      console.log(msg);
    }
    console.log(chalk.red("Some steps failed while updating schema."));
    process.exit(1);
  }
}

async function pushSchema(appId, opts) {
  const schema = await readLocalSchemaFileWithErrorLogging();
  if (!schema) return;

  console.log("Planning...");

  const planRes = await fetchJson({
    method: "POST",
    path: `/dash/apps/${appId}/schema/push/plan`,
    debugName: "Schema plan",
    errorMessage: "Failed to update schema.",
    body: {
      schema,
      check_types: !opts?.skipCheckTypes,
      supports_background_updates: true,
    },
  });

  if (!planRes.ok) return;

  if (!planRes.data.steps.length) {
    console.log("No schema changes detected.  Exiting.");
    return;
  }

  console.log(
    "The following changes will be applied to your production schema:",
  );

  for (const [action, attr] of planRes.data.steps) {
    switch (action) {
      case "add-attr":
      case "update-attr": {
        const valueType = attr["value-type"];
        const isAdd = action === "add-attr";
        if (valueType === "blob" && attrFwdLabel(attr) === "id") {
          console.log(
            `${isAdd ? chalk.magenta("ADD ENTITY") : chalk.magenta("UPDATE ENTITY")} ${attrFwdName(attr)}`,
          );
          break;
        }

        if (valueType === "blob") {
          console.log(
            `${isAdd ? chalk.green("ADD ATTR") : chalk.blue("UPDATE ATTR")} ${attrFwdName(attr)} :: unique=${attr["unique?"]}, indexed=${attr["index?"]}`,
          );
          break;
        }

        console.log(
          `${isAdd ? chalk.green("ADD LINK") : chalk.blue("UPDATE LINK")} ${attrFwdName(attr)} <=> ${attrRevName(attr)}`,
        );
        break;
      }
      case "check-data-type": {
        console.log(
          `${chalk.green("CHECK TYPE")} ${attrFwdName(attr)} => ${attr["checked-data-type"]}`,
        );
        break;
      }
      case "remove-data-type": {
        console.log(`${chalk.red("REMOVE TYPE")} ${attrFwdName(attr)} => any`);
        break;
      }
      case "index": {
        console.log("%s on %s", chalk.green("ADD INDEX"), attrFwdName(attr));
        break;
      }
      case "remove-index": {
        console.log("%s on %s", chalk.red("REMOVE INDEX"), attrFwdName(attr));
        break;
      }
      case "unique": {
        console.log(
          "%s to %s",
          chalk.green("ADD UNIQUE CONSTRAINT"),
          attrFwdName(attr),
        );
        break;
      }
      case "remove-unique": {
        console.log(
          "%s from %s",
          chalk.red("REMOVE UNIQUE CONSTRAINT"),
          attrFwdName(attr),
        );
        break;
      }
    }
  }

  const okPush = await promptOk("OK to proceed?");
  if (!okPush) return;

  const applyRes = await fetchJson({
    method: "POST",
    path: `/dash/apps/${appId}/schema/push/apply`,
    debugName: "Schema apply",
    errorMessage: "Failed to update schema.",
    body: {
      schema,
      check_types: !opts?.skipCheckTypes,
      supports_background_updates: true,
    },
  });

  if (!applyRes.ok) return;

  if (applyRes.data["indexing-jobs"]) {
    await waitForIndexingJobsToFinish(appId, applyRes.data["indexing-jobs"]);
  }

  console.log(chalk.green("Schema updated!"));

  return true;
}

async function pushPerms(appId) {
  const perms = await readLocalPermsFileWithErrorLogging();
  if (!perms) {
    return;
  }

  const ok = await promptOk(
    "Pushing permissions rules. This will immediately replace your production rules. OK to proceed?",
  );
  if (!ok) return;

  const permsRes = await fetchJson({
    method: "POST",
    path: `/dash/apps/${appId}/rules`,
    debugName: "Schema apply",
    errorMessage: "Failed to update schema.",
    body: {
      code: perms,
    },
  });

  if (!permsRes.ok) return;

  console.log(chalk.green("Permissions updated!"));

  return true;
}

async function waitForAuthToken({ secret }) {
  for (let i = 1; i <= 120; i++) {
    await sleep(1000);
    const authCheckRes = await fetchJson({
      method: "POST",
      debugName: "Auth check",
      errorMessage: "Failed to check auth status.",
      path: "/dash/cli/auth/check",
      body: { secret },
      noAuth: true,
      noLogError: true,
    });
    if (authCheckRes.ok) {
      return authCheckRes.data;
    }
    if (authCheckRes.data?.hint.errors?.[0]?.issue === "waiting-for-user") {
      continue;
    }
    error('Failed to authenticate ');
    prettyPrintJSONErr(authCheckRes.data);
    return;
  }
  error("Timed out waiting for authentication");
  return null;
}

// resources

/**
 * Fetches JSON data from a specified path using the POST method.
 *
 * @param {Object} options
 * @param {string} options.debugName
 * @param {string} options.errorMessage
 * @param {string} options.path
 * @param {'POST' | 'GET'} [options.method]
 * @param {Object} [options.body=undefined]
 * @param {boolean} [options.noAuth]
 * @param {boolean} [options.noLogError]
 * @returns {Promise<{ ok: boolean; data: any }>}
 */
async function fetchJson({
  debugName,
  errorMessage,
  path,
  body,
  method,
  noAuth,
  noLogError,
}) {
  const withAuth = !noAuth;
  const withErrorLogging = !noLogError;
  let authToken = null;
  if (withAuth) {
    authToken = await readConfigAuthTokenWithErrorLogging();
    if (!authToken) {
      return { ok: false, data: undefined };
    }
  }
  const timeoutMs = 1000 * 60 * 5; // 5 minutes

  try {
    const res = await fetch(`${instantBackendOrigin}${path}`, {
      method: method ?? "GET",
      headers: {
        ...(withAuth ? { Authorization: `Bearer ${authToken}` } : {}),
        "Content-Type": "application/json",
        "Instant-CLI-Version": version,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (verbose) {
      console.log(debugName, "response:", res.status, res.statusText);
    }

    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (verbose && data) {
      console.log(debugName, "json:", JSON.stringify(data));
    }
    if (!res.ok) {
      if (withErrorLogging) {
        error(errorMessage);
        prettyPrintJSONErr(data);
      }
      return { ok: false, data };
    }

    if (verbose) {
      console.log(debugName, "data:", data);
    }

    return { ok: true, data };
  } catch (err) {
    if (withErrorLogging) {
      if (err.name === "AbortError") {
        error(
          `Timeout: It took more than ${timeoutMs / 60000} minutes to get the result.`,
        );
      } else {
        error(`Error: type: ${err.name}, message: ${err.message}`);
      }
    }
    return { ok: false, data: null };
  }
}

function prettyPrintJSONErr(data) {
  if (data?.message) {
    error(data.message);
  }
  if (Array.isArray(data?.hint?.errors)) {
    for (const err of data.hint.errors) {
      error(`${err.in ? err.in.join("->") + ": " : ""}${err.message}`);
    }
  }
  if (!data) {
    error("Failed to parse error response");
  }
}

async function promptOk(message) {
  const options = program.opts();

  if (options.y) return true;

  return await confirm({
    message,
    default: false,
  }).catch(() => false);
}

async function readLocalPermsFile() {
  const { config, sources } = await loadConfig({
    sources: [
      // load from `instant.perms.xx`
      {
        files: "instant.perms",
        extensions: ["ts", "mts", "cts", "js", "mjs", "cjs", "json"],
      },
    ],
    // if false, the only the first matched will be loaded
    // if true, all matched will be loaded and deep merged
    merge: false,
  });

  return {
    perms: config,
    path: sources.at(0),
  };
}

async function readLocalPermsFileWithErrorLogging() {
  const { perms } = await readLocalPermsFile();
  if (!perms) {
    error(
      `We couldn't find your ${chalk.yellow("`instant.perms.ts`")} file. Make sure it's in the root directory.`,
    );
  }
  return perms;
}

async function readLocalSchemaFile() {
  return (
    await loadConfig({
      sources: [
        // load from `instant.config.xx`
        {
          files: "instant.schema",
          extensions: ["ts", "mts", "cts", "js", "mjs", "cjs"],
        },
      ],
      // if false, the only the first matched will be loaded
      // if true, all matched will be loaded and deep merged
      merge: false,
    })
  ).config;
}

async function readInstantConfigFile() {
  return (
    await loadConfig({
      sources: [
        // load from `instant.config.xx`
        {
          files: "instant.config",
          extensions: ["ts", "mts", "cts", "js", "mjs", "cjs", "json"],
        },
      ],
      // if false, the only the first matched will be loaded
      // if true, all matched will be loaded and deep merged
      merge: false,
    })
  ).config;
}

async function readLocalSchemaFileWithErrorLogging() {
  const schema = await readLocalSchemaFile();

  if (!schema) {
    error(
      `We couldn't find your ${chalk.yellow("`instant.schema.ts`")} file. Make sure it's in the root directory.`,
    );
    return;
  }

  return schema;
}

async function readConfigAuthToken() {
  const options = program.opts();
  if (options.token) {
    return options.token;
  }

  if (process.env.INSTANT_CLI_AUTH_TOKEN) {
    return process.env.INSTANT_CLI_AUTH_TOKEN;
  }

  const authToken = await readFile(
    getAuthPaths().authConfigFilePath,
    "utf-8",
  ).catch(() => null);

  return authToken;
}
async function readConfigAuthTokenWithErrorLogging() {
  const token = await readConfigAuthToken();
  if (!token) {
    error(
      `Looks like you are not logged in. Please log in with ${chalk.green("`instant-cli login`")}`,
    );
  }
  return token;
}

async function saveConfigAuthToken(authToken) {
  const authPaths = getAuthPaths();

  await mkdir(authPaths.appConfigDirPath, {
    recursive: true,
  });

  return writeFile(authPaths.authConfigFilePath, authToken, "utf-8");
}

function getAuthPaths() {
  const key = `instantdb-${dev ? "dev" : "prod"}`;
  const { config: appConfigDirPath } = envPaths(key);
  const authConfigFilePath = join(appConfigDirPath, "a");

  return { authConfigFilePath, appConfigDirPath };
}

// utils

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countEntities(o) {
  return Object.keys(o).length;
}

function sortedEntries(o) {
  return Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
}

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

function indentLines(s, n) {
  return s
    .split("\n")
    .map((c) => `${"  ".repeat(n)}${c}`)
    .join("\n");
}

// attr helpers

function attrFwdLabel(attr) {
  return attr["forward-identity"]?.[2];
}

function attrFwdEtype(attr) {
  return attr["forward-identity"]?.[1];
}

function attrRevLabel(attr) {
  return attr["reverse-identity"]?.[2];
}

function attrRevEtype(attr) {
  return attr["reverse-identity"]?.[1];
}

function attrFwdName(attr) {
  return `${attrFwdEtype(attr)}.${attrFwdLabel(attr)}`;
}

function attrRevName(attr) {
  if (attr["reverse-entity"]) {
    return `${attrRevEtype(attr)}.${attrRevLabel(attr)}`;
  }
}

// templates and constants

export const rels = {
  "many-false": ["many", "many"],
  "one-true": ["one", "one"],
  "many-true": ["many", "one"],
  "one-false": ["one", "many"],
};

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(uuid) {
  return uuidRegex.test(uuid);
}

async function detectAppIdFromOptsWithErrorLogging(opts) {
  if (!opts.app) return { ok: true };
  const appId = opts.app;
  const config = await readInstantConfigFile();
  const nameMatch = config?.apps?.[appId];
  const namedAppId = nameMatch?.id && isUUID(nameMatch.id) ? nameMatch : null;
  const uuidAppId = appId && isUUID(appId) ? appId : null;

  if (nameMatch && !namedAppId) {
    error(`Expected \`${appId}\` to point to a UUID, but got ${nameMatch.id}.`);
    return { ok: false };
  }
  if (!namedAppId && !uuidAppId) {
    error(`Expected App ID to be a UUID, but got: ${chalk.red(appId)}`);
    return { ok: false };
  }
  return { ok: true, appId: namedAppId || uuidAppId };
}

function detectAppIdFromEnvWithErrorLogging() {
  const found = Object.keys(potentialEnvs)
    .map((type) => {
      const envName = potentialEnvs[type];
      const value = process.env[envName];
      return { type, envName, value };
    })
    .find(({ value }) => !!value);
  if (found && !isUUID(found.value)) {
    error(
      `Found ${chalk.green("`" + found.envName + "`")} but it's not a valid UUID.`,
    );
    return { ok: false, found };
  }
  return { ok: true, found };
}

async function getAppIdWithErrorLogging(arg) {
  const fromArg = await detectAppIdFromOptsWithErrorLogging({
    app: arg,
  });
  if (!fromArg.ok) return;
  if (fromArg.appId) {
    return fromArg.appId;
  }
  const fromEnv = detectAppIdFromEnvWithErrorLogging();
  if (!fromEnv.ok) return;
  if (fromEnv.found) {
    const { envName, value } = fromEnv.found;
    console.log(`Found ${chalk.green(envName)}: ${value}`);
    return value;
  }
  // otherwise, instruct the user to set one of these up
  error(noAppIdErrorMessage);

  return;
}

function appDashUrl(id) {
  return `${instantDashOrigin}/dash?s=main&t=home&app=${id}`;
}

function instantSchemaTmpl(title, id, instantModuleName) {
  return /* ts */ `// ${title}
// ${appDashUrl(id)}

import { i } from "${instantModuleName ?? "@instantdb/core"}";

// Example entities and links (you can delete these!)
const graph = i.graph(
  {
    posts: i.entity({
      name: i.string(),
      content: i.string(),
    }),
    authors: i.entity({
      userId: i.string(),
      name: i.string(),
    }),
    tags: i.entity({
      label: i.string(),
    }),
  },
  {
    authorPosts: {
      forward: {
        on: "authors",
        has: "many",
        label: "posts",
      },
      reverse: {
        on: "posts",
        has: "one",
        label: "author",
      },
    },
    postsTags: {
      forward: {
        on: "posts",
        has: "many",
        label: "tags",
      },
      reverse: {
        on: "tags",
        has: "many",
        label: "posts",
      },
    },
  },
);


export default graph;
`;
}

const examplePermsTmpl = /* ts */ `export default {
  authors: {
    bind: ["isAuthor", "auth.id == data.userId"],
    allow: {
      view: "true",
      create: "isAuthor",
      update: "isAuthor",
      delete: "isAuthor",
    },
  },
  posts: {
    bind: ["isAuthor", "auth.id in data.ref('authors.userId')"],
    allow: {
      view: "true",
      create: "isAuthor",
      update: "isAuthor",
      delete: "isAuthor",
    },
  },
  tags: {
    bind: ["isOwner", "auth.id in data.ref('posts.authors.userId')"],
    allow: {
      view: "true",
      create: "isOwner",
      update: "isOwner",
      delete: "isOwner",
    },
  },
};
`;

function generateSchemaTypescriptFile(id, schema, title, instantModuleName) {
  const entitiesEntriesCode = sortedEntries(schema.blobs)
    .map(([name, attrs]) => {
      // a block of code for each entity
      return [
        `  `,
        `"${name}"`,
        `: `,
        `i.entity`,
        `({`,
        `\n`,
        // a line of code for each attribute in the entity
        sortedEntries(attrs)
          .filter(([name]) => name !== "id")
          .map(([name, config]) => {
            const type = config["checked-data-type"] || "any";

            return [
              `    `,
              `"${name}"`,
              `: `,
              `i.${type}()`,
              config["unique?"] ? ".unique()" : "",
              config["index?"] ? ".indexed()" : "",
              `,`,
            ].join("");
          })
          .join("\n"),
        `\n`,
        `  `,
        `})`,
        `,`,
      ].join("");
    })
    .join("\n");

  const entitiesObjCode = `{\n${entitiesEntriesCode}\n}`;

  const linksEntriesCode = Object.fromEntries(
    sortedEntries(schema.refs).map(([_name, config]) => {
      const [, fe, flabel] = config["forward-identity"];
      const [, re, rlabel] = config["reverse-identity"];
      const [fhas, rhas] = rels[`${config.cardinality}-${config["unique?"]}`];
      return [
        `${fe}${capitalizeFirstLetter(flabel)}`,
        {
          forward: {
            on: fe,
            has: fhas,
            label: flabel,
          },
          reverse: {
            on: re,
            has: rhas,
            label: rlabel,
          },
        },
      ];
    }),
  );

  return `// ${title}
// ${appDashUrl(id)}

import { i } from "${instantModuleName ?? "@instantdb/core"}";

const graph = i.graph(
${indentLines(entitiesObjCode, 1)},
${indentLines(JSON.stringify(linksEntriesCode, null, "  "), 1)}
);

export default graph;
`;
}
