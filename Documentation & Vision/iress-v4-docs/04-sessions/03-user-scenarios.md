# 03 — User Scenarios (License Exhaustion & Force-Close)

If the user is out of licenses, `IRESSSessionStart` returns a SOAP fault with `Number = 25008` and a `<Context>` CDATA block listing **the sessions that are currently using the user's licenses**. You have two options.

## Scenario 1 — list out the sessions in use

The fault's `<Context>` will contain a `<CurrentSessions>` list. Each `<Session>` element has:

| Element | Type | Description |
|---|---|---|
| `SessionNumber` | int | Unique id for the session. Pass it back in `SessionNumberToKick` to end it. |
| `LoginType` | string | Usually the Iress product name (e.g. `NetIressPro`, `ViewPoint`, `Web Services`). |
| `LoginDateTime` | dateTime | When the session began. |
| `LoginDuration` | time | How long it has been running. |
| `ConnectionDescription` | string | e.g. `IP = 203.19.128.30:55303, LanIP = 172.25.224.43:55`. |
| `PhysicalDescription` | string | e.g. `THIRUVIKRAM.MANTHU@AU02-TMANTH-NB3` or a user-agent string. |

You can show the user a "you're logged in N times; kick one?" UI based on this list, and then re-call `IRESSSessionStart` with:

```xml
<v4:SessionNumberToKick>1041878485</v4:SessionNumberToKick>
<v4:KickLikeSessions>true</v4:KickLikeSessions>
```

> Setting `KickLikeSessions = true` means: if the nominated session has already ended, a "like" session of the same login type as the nominated one will be ended. This protects against races where the user closes the session between your read and your kick.

⚠️ You may still fail to get a new session if other sessions of a **different** login type have started since your read. In that case, fall back to Scenario 2.

## Scenario 2 — force-close any existing session

If you don't want to deal with the list, send `SessionNumberToKick = -1` to **end every existing session** for this user:

```xml
<v4:IRESSSessionStart>
  <v4:Input>
    <v4:Header>
      <v4:SessionKey></v4:SessionKey>
      <v4:RequestID>init-1</v4:RequestID>
      <v4:Updates>false</v4:Updates>
      <v4:Timeout>25</v4:Timeout>
      <v4:PageSize>0</v4:PageSize>
      <v4:WaitForResponse>true</v4:WaitForResponse>
      <v4:PagingBookmark/>
      <v4:PagingDirection>0</v4:PagingDirection>
      <v4:InputLocalizationType>0</v4:InputLocalizationType>
      <v4:OutputLocalizationType>0</v4:OutputLocalizationType>
    </v4:Header>
    <v4:Parameters>
      <v4:UserName>username</v4:UserName>
      <v4:CompanyName>Company</v4:CompanyName>
      <v4:Password>Password</v4:Password>
      <v4:ApplicationID>Mint-OEMS-…</v4:ApplicationID>
      <v4:ApplicationLabel>Mint-OEMS</v4:ApplicationLabel>
      <v4:PreviousSessionKey/>
      <v4:SessionTimeout/>
      <v4:AuthenticationType/>
      <v4:SessionNumberToKick>-1</v4:SessionNumberToKick>
      <v4:KickLikeSessions>true</v4:KickLikeSessions>
      <v4:Locale>en-ZA</v4:Locale>
      <v4:LocalePrivateUseSubtags/>
    </v4:Parameters>
  </v4:Input>
</v4:IRESSSessionStart>
```

> ⚠️ This is destructive. It will end every other session the user has open, including any browser tab of ViewPoint. **Don't use it by default.** Use it only as a recovery path or when the user has confirmed.

## Mint OEMS — recommended behaviour

- **First attempt:** plain `IRESSSessionStart`. No kick.
- **If you get 25008:** check the `Context` for the number of active sessions.
  - If only this app owns one of them, kick only yours (Scenario 1 with the specific `SessionNumber`).
  - If many sessions exist, show the user a list and let them choose. Or wait for a slot.
- **Fallback only on user opt-in:** force-close with `SessionNumberToKick = -1` (Scenario 2). Log the action.

Don't blindly force-close — you'll cause data loss in the user's other tabs / sessions.
