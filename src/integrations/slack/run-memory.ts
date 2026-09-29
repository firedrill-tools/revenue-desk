// What a run remembers about the Slack channels it saw (the gateway's
// RunMemory, src/gateway/catalog.ts). A post names its channel by id or by
// name; whether it is an allowlisted channel, and whether the channel is
// shared with another organisation, only Slack's own results say: channel
// searches and lists, and the id Slack answered a post by name with.
// Nothing is learned from the model's input alone, and a failed call
// teaches nothing.

import type { Classification, ClassifierSettings } from "../../contracts/integration.js";
import type { JsonObject, JsonValue } from "../../contracts/json.js";
import type { RunMemory } from "../../gateway/catalog.js";
import { arr } from "../shared/json.js";
import {
  channelFrom,
  type KnownChannel,
  postedChannel,
  resultData,
  type SlackKnown,
} from "./channels.js";
import { classifySlack } from "./classify.js";

const CHANNEL_LISTS = new Set(["SLACK_FIND_CHANNELS", "SLACK_LIST_ALL_CHANNELS"]);

export class SlackRunMemory implements RunMemory, SlackKnown {
  readonly #settings: ClassifierSettings;
  readonly #byId = new Map<string, KnownChannel>();

  constructor(settings: ClassifierSettings) {
    this.#settings = settings;
  }

  channelById(id: string): KnownChannel | undefined {
    return this.#byId.get(id);
  }

  channelByName(name: string): KnownChannel | undefined {
    for (const channel of this.#byId.values()) if (channel.name === name) return channel;
    return undefined;
  }

  record(tool: string, input: JsonObject, output: JsonValue, isError: boolean): void {
    if (isError) return;
    if (CHANNEL_LISTS.has(tool)) {
      for (const value of arr(resultData(output), "channels") ?? []) {
        const channel = channelFrom(value);
        if (channel !== null) this.#learn(channel);
      }
    } else if (tool === "SLACK_SEND_MESSAGE") {
      const channel = postedChannel(input, output);
      if (channel !== null) this.#learn(channel);
    }
  }

  refine(tool: string, input: JsonObject, classification: Classification): Classification {
    if (tool !== "SLACK_SEND_MESSAGE" && tool !== "SLACK_ADD_REACTION_TO_AN_ITEM") {
      return classification;
    }
    return classifySlack(tool, input, this.#settings, this) ?? classification;
  }

  /** A channel search's facts win over a post's; a shared channel stays shared. */
  #learn(channel: KnownChannel): void {
    const previous = this.#byId.get(channel.id);
    this.#byId.set(channel.id, {
      id: channel.id,
      name: channel.name ?? previous?.name ?? null,
      externallyShared: channel.externallyShared || previous?.externallyShared === true,
    });
  }
}
