/**
 * Team-name helpers. No "server-only" here on purpose: the client needs shortTeam too
 * (open limit orders carry Polymarket’s raw outcome names).
 */

function norm(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sameTeam(text: string, team: string): boolean {
  const t = norm(team);
  const x = norm(text);
  if (!t) return false;
  if (x.includes(t)) return true;
  // fall back to the most distinctive word (e.g. "necaxa" in "Club Necaxa")
  const words = t.split(" ").filter((w) => w.length > 3 && !["club", "fc", "cf", "cd", "de", "la", "los", "las", "del", "united", "city"].includes(w));
  return words.some((w) => x.includes(w));
}

const TEAM_NOISE = new Set(["club", "fc", "cf", "cd", "sc", "rc", "rcd", "ud", "sd", "ac", "afc", "ss", "us", "as", "de", "la", "del", "unam", "uanl", "futbol", "fútbol"]);
const TEAM_OVERRIDES: Record<string, string> = {
  "Pumas de la UNAM": "Pumas",
  "Tigres de la UANL": "Tigres",
  "CD Guadalajara": "Chivas",
  "Club Atlético de Madrid": "Atlético",
  "RCD Espanyol de Barcelona": "Espanyol",
  "RC Deportivo A Coruña": "Deportivo",
  "Atlético de San Luis": "San Luis",
  "FC Juárez": "Juárez",
  // MLB (Polymarket writes the full "City Nickname"; the card wants the nickname)
  "Arizona Diamondbacks": "Diamondbacks",
  "Atlanta Braves": "Braves",
  "Baltimore Orioles": "Orioles",
  "Boston Red Sox": "Red Sox",
  "Chicago Cubs": "Cubs",
  "Chicago White Sox": "White Sox",
  "Cincinnati Reds": "Reds",
  "Cleveland Guardians": "Guardians",
  "Colorado Rockies": "Rockies",
  "Detroit Tigers": "Tigers",
  "Houston Astros": "Astros",
  "Kansas City Royals": "Royals",
  "Los Angeles Angels": "Angels",
  "Los Angeles Dodgers": "Dodgers",
  "Miami Marlins": "Marlins",
  "Milwaukee Brewers": "Brewers",
  "Minnesota Twins": "Twins",
  "New York Mets": "Mets",
  "New York Yankees": "Yankees",
  "Oakland Athletics": "Athletics",
  "Sacramento Athletics": "Athletics",
  "Philadelphia Phillies": "Phillies",
  "Pittsburgh Pirates": "Pirates",
  "San Diego Padres": "Padres",
  "San Francisco Giants": "Giants",
  "Seattle Mariners": "Mariners",
  "St. Louis Cardinals": "Cardinals",
  "Tampa Bay Rays": "Rays",
  "Texas Rangers": "Rangers",
  "Toronto Blue Jays": "Blue Jays",
  "Washington Nationals": "Nationals",
};

/** "Club Necaxa" → "Necaxa", "Atlas FC" → "Atlas". Full names stay in the game title. */
export function shortTeam(raw: string): string {
  const name = raw.trim();
  if (TEAM_OVERRIDES[name]) return TEAM_OVERRIDES[name];
  const words = name.split(/\s+/);
  const kept = words.filter((w) => !TEAM_NOISE.has(w.toLowerCase().replace(/\./g, "")));
  return (kept.length ? kept : words).join(" ");
}
