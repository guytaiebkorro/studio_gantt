#!/usr/bin/env node
// ---------------------------------------------------------------------------
// gantt-admin — provisioning CLI for the Gantt app's Firebase backend.
//
// Workspaces exist ONLY because this tool creates them: firestore.rules denies
// /workspaces create and delete to every client, and the Admin SDK used here
// bypasses rules via IAM. That asymmetry is the design, not a workaround.
//
// Setup:
//   gcloud auth application-default login
//   gcloud auth application-default set-quota-project korro-gantt
//   cd tools/admin && npm install
//
// Then:
//   node bin/gantt-admin.js doctor
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from "node:fs";
import * as cmd from "../src/commands.js";

const USAGE = `
gantt-admin — provision and manage Gantt workspaces

  doctor
      Check credentials, Firestore access, the members.email collection-group
      index, and per-workspace integrity (admins, protected member, board index
      drift). Run this first when anything looks wrong.

  workspace:create --name "Studio" --admin someone@example.com [--id studio]
      Create a workspace with a starter board and a PROTECTED founding admin.
      --id defaults to a slug of the name.

  workspace:list [--json]
  workspace:rename <wsId> --name "New name"
  workspace:delete <wsId> --yes          (recursive: members + boards too)

  member:list <wsId> [--json]
  member:add <wsId> --email a@b.com --role admin|editor|viewer [--protected]
  member:set-role <wsId> --email a@b.com --role admin|editor|viewer
  member:remove <wsId> --email a@b.com

  board:list <wsId> [--json]
  board:export <wsId> <boardId> [--out board.json]
  board:import <wsId> --file board.json [--name "Name"]

  import:jsonbin <wsId> --key-env JB_KEY [--registry <binId>] [--dry-run] [--keep-starter]
      One-time migration off the old JSONBin backend. Reads the account's
      registry bin and every board it lists, applies the app's board invariants,
      and writes them into an EXISTING workspace. Reuses each bin id as the
      Firestore document id, so re-running overwrites rather than duplicates.
      Removes the empty starter board unless --keep-starter.
      Prefer --key-env over --key: a command line ends up in your shell history,
      and a Master Key is an unscopable account-wide credential. Rotate it after.

Notes
  * A member document IS the invite. Adding someone who has never signed in is
    normal and expected — they get access the moment they sign in with Google.
  * Emails are lowercased and validated against the same pattern firestore.rules
    enforces, because the member document's id IS the email.
`;

const ROLE_HINT = "admin, editor or viewer";

// Tiny flag parser: --key value, --flag, and bare positionals.
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else pos.push(a);
  }
  return { flags, pos };
}

function need(flags, name, hint) {
  const v = flags[name];
  if (v === undefined || v === true || v === "") {
    throw new Error(`Missing --${name}${hint ? ` (${hint})` : ""}`);
  }
  return v;
}

function table(rows, cols) {
  if (!rows.length) { console.log("  (none)"); return; }
  const widths = cols.map((c) =>
    Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? "").length)));
  const line = (cells) => "  " + cells.map((s, i) => String(s).padEnd(widths[i])).join("  ");
  console.log(line(cols.map((c) => c.label)));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => c.get(r) ?? "")));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);

  if (!command || command === "help" || flags.help) { console.log(USAGE); return; }

  switch (command) {
    case "doctor": {
      const findings = await cmd.doctor();
      let bad = 0;
      for (const f of findings) {
        if (!f.ok) bad++;
        console.log(`  ${f.ok ? "ok  " : "FAIL"}  ${f.msg}`);
      }
      console.log(bad ? `\n${bad} problem(s) found.` : "\nAll checks passed.");
      if (bad) process.exitCode = 1;
      break;
    }

    case "workspace:create": {
      const r = await cmd.workspaceCreate({
        name: need(flags, "name", 'e.g. --name "Studio"'),
        admin: need(flags, "admin", "the workspace admin's Google email"),
        id: flags.id === true ? undefined : flags.id
      });
      console.log(`Created workspace "${r.wsName}"  (id: ${r.wsId})`);
      console.log(`  admin:  ${r.adminEmail}   [protected — only this CLI can change or remove them]`);
      console.log(`  board:  ${r.boardId} ("My Board")`);
      console.log(`\n${r.adminEmail} gets access the moment they sign in with Google.`);
      console.log(`Share link once the app is migrated:  #ws=${r.wsId}`);
      break;
    }

    case "workspace:list": {
      const rows = await cmd.workspaceList();
      if (flags.json) { console.log(JSON.stringify(rows, null, 2)); break; }
      table(rows, [
        { label: "ID", get: (r) => r.id },
        { label: "NAME", get: (r) => r.name },
        { label: "BOARDS", get: (r) => r.boards },
        { label: "MEMBERS", get: (r) => r.members },
        { label: "A/E/V", get: (r) => `${r.counts.admin}/${r.counts.editor}/${r.counts.viewer}` },
        { label: "UNCLAIMED", get: (r) => r.counts.unclaimed },
        { label: "OWNER", get: (r) => r.ownerEmail }
      ]);
      break;
    }

    case "workspace:rename": {
      const r = await cmd.workspaceRename({ wsId: pos[0], name: need(flags, "name") });
      console.log(`Renamed "${r.wsId}" to "${r.wsName}"`);
      break;
    }

    case "workspace:delete": {
      if (!pos[0]) throw new Error("Usage: workspace:delete <wsId> --yes");
      if (!flags.yes) {
        throw new Error(
          `This deletes "${pos[0]}" AND all its members and boards, permanently.\n` +
          `There is no undo and no version history to restore from.\n` +
          `Re-run with --yes if you are sure.`
        );
      }
      const r = await cmd.workspaceDelete({ wsId: pos[0] });
      console.log(`Deleted workspace "${r.wsId}" and everything under it.`);
      break;
    }

    case "member:list": {
      const rows = await cmd.memberList({ wsId: pos[0] });
      if (flags.json) { console.log(JSON.stringify(rows, null, 2)); break; }
      table(rows, [
        { label: "EMAIL", get: (r) => r.email },
        { label: "ROLE", get: (r) => r.role },
        { label: "SIGNED IN", get: (r) => (r.claimed ? "yes" : "not yet") },
        { label: "PROTECTED", get: (r) => (r.protected ? "yes" : "") },
        { label: "INVITED BY", get: (r) => r.invitedBy }
      ]);
      break;
    }

    case "member:add": {
      const r = await cmd.memberAdd({
        wsId: pos[0],
        email: need(flags, "email"),
        role: need(flags, "role", ROLE_HINT),
        protectedFlag: !!flags.protected
      });
      console.log(`Added ${r.email} to "${r.wsId}" as ${r.role}${r.protected ? " [protected]" : ""}.`);
      console.log("They get access the moment they sign in with Google.");
      break;
    }

    case "member:set-role": {
      const r = await cmd.memberSetRole({
        wsId: pos[0], email: need(flags, "email"), role: need(flags, "role", ROLE_HINT)
      });
      console.log(`${r.email} in "${r.wsId}": ${r.was} -> ${r.role}`);
      console.log("Their open tab keeps its old role until the next write is refused; it then re-reads.");
      break;
    }

    case "member:remove": {
      const r = await cmd.memberRemove({ wsId: pos[0], email: need(flags, "email") });
      console.log(`Removed ${r.email} from "${r.wsId}".`);
      break;
    }

    case "board:list": {
      const r = await cmd.boardList({ wsId: pos[0] });
      if (flags.json) { console.log(JSON.stringify(r, null, 2)); break; }
      table(r.boards, [
        { label: "ID", get: (b) => b.id },
        { label: "NAME", get: (b) => b.indexName },
        { label: "TASKS", get: (b) => (b.tasks ?? "?") },
        { label: "GROUPS", get: (b) => (b.groups ?? "?") },
        { label: "BYTES", get: (b) => (b.bytes ?? "?") }
      ]);
      if (r.orphans.inIndexOnly.length) console.log("\n  ! index lists missing boards: " + r.orphans.inIndexOnly.join(", "));
      if (r.orphans.inStoreOnly.length) console.log("  ! boards absent from the index: " + r.orphans.inStoreOnly.join(", "));
      break;
    }

    case "board:export": {
      if (!pos[1]) throw new Error("Usage: board:export <wsId> <boardId> [--out file.json]");
      const board = await cmd.boardExport({ wsId: pos[0], boardId: pos[1] });
      const json = JSON.stringify(board, null, 2);
      if (flags.out && flags.out !== true) { writeFileSync(flags.out, json); console.log(`Wrote ${flags.out}`); }
      else console.log(json);
      break;
    }

    case "board:import": {
      const file = need(flags, "file", "path to a board JSON file");
      const board = JSON.parse(readFileSync(file, "utf8"));
      const r = await cmd.boardImport({
        wsId: pos[0], board, name: flags.name === true ? undefined : flags.name
      });
      console.log(`Imported ${r.tasks} tasks into "${r.wsId}" as "${r.name}" (${r.boardId}).`);
      break;
    }

    case "import:jsonbin": {
      if (!pos[0]) throw new Error("Usage: import:jsonbin <wsId> --key-env JB_KEY [--dry-run]");
      const key = flags["key-env"] && flags["key-env"] !== true
        ? process.env[flags["key-env"]]
        : (flags.key !== true ? flags.key : undefined);
      if (!key) {
        throw new Error(
          "No JSONBin Master Key. Preferred:\n" +
          "  export JB_KEY='<master key>'\n" +
          "  node bin/gantt-admin.js import:jsonbin <wsId> --key-env JB_KEY"
        );
      }
      const { importJsonbin } = await import("../src/import-jsonbin.js");
      await importJsonbin({
        key,
        wsId: pos[0],
        registryId: flags.registry !== true ? flags.registry : undefined,
        dryRun: !!flags["dry-run"],
        replaceEmptyStarter: !flags["keep-starter"]
      });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error("\n" + (err && err.message ? err.message : String(err)) + "\n");
  process.exitCode = 1;
});
