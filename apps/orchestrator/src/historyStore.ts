import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SwarmCycleState } from "@swarm/shared";

export type SessionSummary = {
  sessionId: string;
  userId: string;
  createdAt: number;
  lastActivityAt: number;
  cycleCount: number;
  latestCycleId: string | null;
};

export type CycleSummary = {
  sessionId: string;
  userId: string;
  cycleId: string;
  startedAt: number;
  completedAt: number | null;
  status: "completed" | "failed";
  state: SwarmCycleState;
};

type SessionMetaItem = {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entity: "SESSION_META";
  sessionId: string;
  userId: string;
  createdAt: number;
  lastActivityAt: number;
  cycleCount: number;
  latestCycleId: string | null;
};

type CycleItem = {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entity: "CYCLE";
  sessionId: string;
  userId: string;
  cycleId: string;
  startedAt: number;
  completedAt: number | null;
  status: "completed" | "failed";
  state: SwarmCycleState;
};

export class DynamoHistoryStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(
    region: string,
    tableName: string,
    _userGsiName: string,
    credentials?: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    },
  ) {
    const client = new DynamoDBClient(
      credentials ? { region, credentials } : { region },
    );
    this.doc = DynamoDBDocumentClient.from(client);
    this.tableName = tableName;
  }

  async recordCycle(
    userId: string,
    sessionId: string,
    state: SwarmCycleState,
  ): Promise<void> {
    const now = Date.now();
    const completedAt = state.completedAt ?? null;
    const status: "completed" | "failed" =
      state.execution?.success === false ? "failed" : "completed";
    const existingSession = await this.getSessionByUser(userId, sessionId);

    const sessionMeta: SessionMetaItem = {
      PK: this.userPk(userId),
      SK: this.sessionMetaSk(sessionId),
      GSI1PK: this.userPk(userId),
      GSI1SK: this.sessionMetaSk(sessionId),
      entity: "SESSION_META",
      sessionId,
      userId,
      createdAt: existingSession?.createdAt ?? state.startedAt,
      lastActivityAt: completedAt ?? now,
      cycleCount: (existingSession?.cycleCount ?? 0) + 1,
      latestCycleId: state.cycleId,
    };

    const cycleItem: CycleItem = {
      PK: this.userPk(userId),
      SK: this.cycleSk(sessionId, state.startedAt, state.cycleId),
      GSI1PK: this.userPk(userId),
      GSI1SK: this.cycleSk(sessionId, state.startedAt, state.cycleId),
      entity: "CYCLE",
      sessionId,
      userId,
      cycleId: state.cycleId,
      startedAt: state.startedAt,
      completedAt,
      status,
      state,
    };

    await Promise.all([
      this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: cycleItem,
        }),
      ),
      this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: sessionMeta,
        }),
      ),
    ]);
  }

  async listSessionsByUser(
    userId: string,
    limit = 20,
  ): Promise<SessionSummary[]> {
    const res = await this.doc.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: "entity = :entity AND userId = :userId",
        ExpressionAttributeValues: {
          ":entity": "SESSION_META",
          ":userId": userId,
        },
        Limit: Math.max(1, Math.min(limit * 6, 1000)),
      }),
    );

    const rows = (res.Items ?? []) as SessionMetaItem[];
    rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return rows.slice(0, Math.max(1, Math.min(limit, 100))).map((item) => ({
      sessionId: item.sessionId,
      userId: item.userId,
      createdAt: item.createdAt,
      lastActivityAt: item.lastActivityAt,
      cycleCount: item.cycleCount,
      latestCycleId: item.latestCycleId,
    }));
  }

  async getSession(sessionId: string): Promise<SessionSummary | null> {
    const session = await this.getSessionBySessionId(sessionId);
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      cycleCount: session.cycleCount,
      latestCycleId: session.latestCycleId,
    };
  }

  async listCycles(sessionId: string, limit = 50): Promise<CycleSummary[]> {
    const res = await this.doc.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: "entity = :entity AND sessionId = :sessionId",
        ExpressionAttributeValues: {
          ":entity": "CYCLE",
          ":sessionId": sessionId,
        },
        Limit: Math.max(1, Math.min(limit * 6, 1000)),
      }),
    );

    const rows = (res.Items ?? []) as CycleItem[];
    rows.sort((a, b) => b.startedAt - a.startedAt);
    return rows.slice(0, Math.max(1, Math.min(limit, 200))).map((item) => ({
      sessionId: item.sessionId,
      userId: item.userId,
      cycleId: item.cycleId,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      status: item.status,
      state: item.state,
    }));
  }

  private async getSessionByUser(
    userId: string,
    sessionId: string,
  ): Promise<SessionMetaItem | null> {
    const res = await this.doc.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression:
          "entity = :entity AND userId = :userId AND sessionId = :sessionId",
        ExpressionAttributeValues: {
          ":entity": "SESSION_META",
          ":userId": userId,
          ":sessionId": sessionId,
        },
        Limit: 1,
      }),
    );
    return (res.Items?.[0] as SessionMetaItem | undefined) ?? null;
  }

  private async getSessionBySessionId(
    sessionId: string,
  ): Promise<SessionMetaItem | null> {
    const res = await this.doc.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: "entity = :entity AND sessionId = :sessionId",
        ExpressionAttributeValues: {
          ":entity": "SESSION_META",
          ":sessionId": sessionId,
        },
        Limit: 1,
      }),
    );
    return (res.Items?.[0] as SessionMetaItem | undefined) ?? null;
  }

  private userPk(userId: string): string {
    return `USER#${userId}`;
  }

  private sessionMetaSk(sessionId: string): string {
    return `META#SESSION#${sessionId}`;
  }

  private cycleSk(
    sessionId: string,
    startedAt: number,
    cycleId: string,
  ): string {
    return `CYCLE#${sessionId}#${startedAt}#${cycleId}`;
  }
}
