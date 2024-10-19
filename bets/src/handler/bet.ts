import { HandlerContext, User } from "@xmtp/message-kit";
import OpenAI from "openai";
import axios from "axios";

const openai = new OpenAI({
  apiKey: process.env.OPEN_AI_API_KEY,
});

interface Bet {
  prompt: string;
  amount: number;
  agreedUsers: string[];
  disagreedUsers: string[];
  responses: Map<string, string>;
  status: string;
  timestamps: {
    createdAt: number;
  };
}

const Bets = new Map();
let activeBetCounter = 0;
let systemPrompt;
let reply;

// Main handler function for processing commands
export async function handler(context: HandlerContext) {
  if (!process?.env?.OPEN_AI_API_KEY) {
    console.log("No OPEN_AI_API_KEY found in .env");
    return;
  }

  const {
    message: {
      content: { command, params },
    },
  } = context;

  switch (command) {
    case "bet":
      const rawPrompt = params.prompt;
      const rawAmount = params.amount;

      // Ensure that the last part is treated as the amount, while the rest is the prompt
      const words = rawPrompt.split(" ");
      const amount = parseFloat(words.pop()); // Extracts the last element as the amount
      const prompt = words.join(" "); // Remaining words form the prompt

      if (!prompt || isNaN(amount)) {
        context.reply(
          "Invalid bet format. Please provide a prompt and a valid amount."
        );
        return;
      }

      // Get current timestamp
      const currentTimestamp = Date.now();

      systemPrompt = `
      ### Context
      Given the current timestamp ${currentTimestamp} and user promt to bet on a winning outcome sometime in the future, figure out when they are trying to place the bet and output it in the format e.g 2024-10-19.
      The current year is 2024. All future dates will be creater than 2024 October 18
      ### Output: 
      Just the time in the format e.g. "2024-10-19"
      `;

      reply = (await textGeneration(prompt, systemPrompt)).reply;

      console.log("Future time:", reply);

      const sportsData = await fetchNBAGames(reply);
      console.log("sportsData", sportsData);

      systemPrompt = `
      ### Context
      You are a helpful bot agent that lives inside a web3 messaging group for making sports bets. You job is to help see if the provided prompt can be cross reference with an api response
      to see if the existing sports bet exists and the bet can be scheduled. I will be pasting the data source and it needs to see if current user prompt can be used to place a bet.
      Respond "yes" or "no".
      `;

      reply = (
        await textGeneration(prompt, systemPrompt, JSON.stringify(sportsData))
      ).reply;
      console.log("yes/no", reply);

      if (reply === "no") {
        context.send(`Check your calendar grandpa, this game ain't real`);
        return;
      }

      // Increment bet counter for unique ID
      activeBetCounter++;
      const betId = activeBetCounter;

      // Store the bet along with the current timestamp
      Bets.set(betId, {
        prompt,
        amount,
        agreedUsers: [],
        disagreedUsers: [],
        responses: new Map(),
        status: "pending",
        timestamps: {
          createdAt: currentTimestamp,
        },
      });

      context.send(
        `New bet #${betId} proposed: "${prompt}" with an amount of ${amount}. Please respond with /agree ${betId} or /disagree ${betId}.`
      );
      break;

    case "agree":
      const agreeBetId = params.betId;

      if (!agreeBetId) {
        context.reply("Missing required parameters. Please provide betId.");
        return;
      }

      if (!Bets.has(agreeBetId)) {
        context.reply("Bet not found.");
        return;
      }

      await processResponse(context, agreeBetId, "agree");
      break;

    case "disagree":
      const disagreeBetId = params.betId;

      if (!disagreeBetId) {
        context.reply("Missing required parameters. Please provide betId.");
        return;
      }

      if (!Bets.has(disagreeBetId)) {
        context.reply("Bet not found.");
        return;
      }

      await processResponse(context, disagreeBetId, "disagree");
      break;

    case "finalize":
      const finalizeBetId = params.betId;

      if (!finalizeBetId) {
        context.reply("Missing required parameters. Please provide betId.");
        return;
      }

      if (!Bets.has(finalizeBetId)) {
        context.reply("Bet not found.");
        return;
      }

      await finalizeBet(context, finalizeBetId);
      break;

    case "show":
      const betList = Array.from(Bets.entries())
        .filter(([_, bet]) => bet.status === "pending")
        .map(([id, bet]) => `Bet #${id}: ${bet.prompt} (${bet.amount})`)
        .join("\n");

      if (betList.length > 0) {
        context.send(`Active bets:\n${betList}`);
      } else {
        context.send("No active bets.");
      }
      break;

    default:
      // Handle unknown commands
      context.reply(
        "Unknown command. Use /help to see all available commands."
      );
  }
}

// Handle responses (agree/disagree) to a bet
async function processResponse(
  context: HandlerContext,
  betId: number,
  response: string
) {
  const bet = Bets.get(betId);
  const senderAddress = context.message.sender.address;

  // Remove the sender from the opposite response list if they had previously responded
  if (response === "agree") {
    bet.disagreedUsers = bet.disagreedUsers.filter(
      (user: string) => user !== senderAddress
    );
    if (!bet.agreedUsers.includes(senderAddress)) {
      bet.agreedUsers.push(senderAddress);
    }
  } else if (response === "disagree") {
    bet.agreedUsers = bet.agreedUsers.filter(
      (user: string) => user !== senderAddress
    );
    if (!bet.disagreedUsers.includes(senderAddress)) {
      bet.disagreedUsers.push(senderAddress);
    }
  }

  bet.responses.set(senderAddress, response);

  const agreeCount = bet.agreedUsers.length;
  const disagreeCount = bet.disagreedUsers.length;

  context.send(
    `Someone has responded. There are now ${agreeCount} agrees and ${disagreeCount} disagrees for Bet #${betId}.`
  );
}

// Finalize the bet and display the results
async function finalizeBet(context: HandlerContext, betId: number) {
  const bet = Bets.get(betId);
  const agreeCount = bet.agreedUsers.length;
  const disagreeCount = bet.disagreedUsers.length;

  if (agreeCount > disagreeCount) {
    context.send(
      `Bet #${betId} finalized: Majority agreed to "${bet.prompt}" for ${bet.amount}.`
    );
  } else {
    context.send(
      `Bet #${betId} finalized: Majority disagreed with "${bet.prompt}".`
    );
  }

  // Mark bet as resolved
  Bets.set(betId, {
    ...bet,
    status: "placed",
  });
}

async function textGeneration(
  userPrompt: string,
  systemPrompt: string,
  data?: string
) {
  let messages = [];
  messages.push({
    role: "system",
    content: systemPrompt,
  });
  messages.push({
    role: "user",
    content: userPrompt + `Data Source ${data}`,
  });

  try {
    console.log("calling openAI");
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages as any,
    });
    const reply = response.choices[0].message.content;
    const cleanedReply = reply
      ?.replace(/(\*\*|__)(.*?)\1/g, "$2")
      ?.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$2")
      ?.replace(/^#+\s*(.*)$/gm, "$1")
      ?.replace(/`([^`]+)`/g, "$1")
      ?.replace(/^`|`$/g, "");

    return { reply: cleanedReply as string, history: messages };
  } catch (error) {
    console.error("Failed to fetch from OpenAI:", error);
    throw error;
  }
}

// ---------------

interface Game {
  id: number;
  date: {
    start: string;
  };
  teams: {
    visitors: {
      name: string;
    };
    home: {
      name: string;
    };
  };
  status: {
    long: string;
  };
  scores?: {
    visitors: {
      points: number;
    };
    home: {
      points: number;
    };
  };
}

interface GameSummary {
  id: number;
  date: string;
  visitor_name: string;
  home_name: string;
  winner: string;
}

export async function fetchNBAGames(date: string): Promise<GameSummary[]> {
  try {
    const response = await axios.get(
      "https://api-nba-v1.p.rapidapi.com/games",
      {
        params: { date },
        headers: {
          "x-rapidapi-key": process.env.RAPIDAPI_KEY || "",
          "x-rapidapi-host": "api-nba-v1.p.rapidapi.com",
        },
      }
    );

    const games: Game[] = response.data.response;
    return resolveGames(games);
  } catch (error) {
    console.error("Error fetching NBA games:", error);
    throw new Error("Failed to fetch NBA games");
  }
}

function resolveGames(games: Game[]): GameSummary[] {
  const results: GameSummary[] = [];

  games.forEach((game) => {
    const visitors = game.teams.visitors;
    const home = game.teams.home;

    if (game.status.long === "Scheduled") {
      results.push({
        id: game.id,
        date: game.date.start,
        visitor_name: visitors.name,
        home_name: home.name,
        winner: "TBD",
      });
    } else if (game.status.long === "Finished") {
      const visitorsPoints = game.scores?.visitors.points || 0;
      const homePoints = game.scores?.home.points || 0;
      const winner = visitorsPoints > homePoints ? visitors.name : home.name;

      results.push({
        id: game.id,
        date: game.date.start,
        visitor_name: visitors.name,
        home_name: home.name,
        winner: winner,
      });
    }
  });

  return results;
}
