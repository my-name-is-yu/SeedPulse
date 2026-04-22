import { fuzzyFilter, fuzzyMatch } from "../fuzzy.js";

export type Suggestion = {
  name: string;
  description: string;
  aliases: string[];
  type: "command" | "goal";
};

const COMMANDS: Suggestion[] = [
  {
    name: "/run",
    aliases: ["/start"],
    description: "Start the goal loop",
    type: "command",
  },
  {
    name: "/stop",
    aliases: ["/quit"],
    description: "Stop the running loop",
    type: "command",
  },
  {
    name: "/status",
    aliases: [],
    description: "Show current progress",
    type: "command",
  },
  {
    name: "/report",
    aliases: [],
    description: "Generate a summary report",
    type: "command",
  },
  {
    name: "/goals",
    aliases: [],
    description: "List all goals",
    type: "command",
  },
  {
    name: "/help",
    aliases: ["?"],
    description: "Show help overlay",
    type: "command",
  },
  {
    name: "/dashboard",
    aliases: [],
    description: "Toggle dashboard sidebar",
    type: "command",
  },
  {
    name: "/settings",
    aliases: ["/config"],
    description: "View and toggle config",
    type: "command",
  },
  {
    name: "/permissions",
    aliases: [],
    description: "Show or update execution policy",
    type: "command",
  },
];

const GOAL_ARG_COMMANDS = ["/run ", "/start "];

function isExactCommandMatch(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return COMMANDS.some((cmd) => {
    if (cmd.name.toLowerCase() === normalized) {
      return true;
    }
    return cmd.aliases.some((alias) => {
      const normalizedAlias = alias.startsWith("/") ? alias : `/${alias}`;
      return normalizedAlias.toLowerCase() === normalized;
    });
  });
}

export function getMatchingSuggestions(
  input: string,
  goalNames: string[],
): Suggestion[] {
  if (!input.startsWith("/")) {
    return [];
  }
  if (isExactCommandMatch(input)) {
    return [];
  }

  for (const prefix of GOAL_ARG_COMMANDS) {
    if (input.startsWith(prefix)) {
      const goalQuery = input.slice(prefix.length);
      if (
        goalNames.some((goal) => goal.toLowerCase() === goalQuery.toLowerCase())
      ) {
        return [];
      }
      const matchedGoals = fuzzyFilter(goalQuery, goalNames, (g) => g, 6);
      return matchedGoals.map((g) => ({
        name: prefix.trimEnd(),
        description: g,
        aliases: [],
        type: "goal",
      }));
    }
  }

  const query = input.slice(1);
  if (!query) {
    return COMMANDS.map((cmd) => ({ ...cmd }));
  }

  const scored: Array<{ cmd: Suggestion; score: number }> = [];

  for (const cmd of COMMANDS) {
    const nameScore = fuzzyMatch(query, cmd.name.slice(1));
    const aliasScores = cmd.aliases.map((a) =>
      a.startsWith("/") ? fuzzyMatch(query, a.slice(1)) : fuzzyMatch(query, a),
    );
    const bestAlias = aliasScores.reduce<number | null>(
      (best, s) => (s !== null && (best === null || s > best) ? s : best),
      null,
    );
    const best =
      nameScore !== null && (bestAlias === null || nameScore >= bestAlias)
        ? nameScore
        : bestAlias;

    if (best !== null) {
      scored.push({ cmd, score: best });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 6).map((s) => s.cmd);
}
