import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from 'discord.js';
import * as resume from './resume.js';
import * as start from './start.js';
import * as stop from './stop.js';
import * as status from './status.js';

export interface SlashCommand {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const commands: SlashCommand[] = [start, stop, status, resume];

export const commandsByName = new Map<string, SlashCommand>(
  commands.map((c) => [c.data.name, c]),
);
