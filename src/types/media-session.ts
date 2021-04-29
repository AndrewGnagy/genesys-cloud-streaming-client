import { MediaSession } from 'stanza/jingle';
import { JingleAction, JINGLE_INFO_ACTIVE } from 'stanza/Constants';
import StatsGatherer, { StatsEvent } from 'webrtc-stats-gatherer';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { JingleReason, JingleInfo, Jingle, JingleIce } from 'stanza/protocol';
import { ActionCallback } from 'stanza/jingle/Session';

export type SessionType = 'softphone' | 'screenShare' | 'screenRecording' | 'collaborateVideo' | 'unknown';

export interface IGenesysCloudMediaSessionParams {
  options: any;
  sessionType: SessionType;
  allowIPv6?: boolean;
  ignoreHostCandidatesFromRemote?: boolean;
}

export class GenesysCloudMediaSession extends MediaSession {
  private statsGatherer?: StatsGatherer;
  conversationId?: string;
  id?: string;
  fromUserId?: string;
  originalRoomJid?: string;
  sessionType: SessionType;
  ignoreHostCandidatesFromRemote: boolean;
  allowIPv6: boolean;

  constructor (params: IGenesysCloudMediaSessionParams) {
    super(params.options);

    this.sessionType = params.sessionType;
    this.ignoreHostCandidatesFromRemote = !!params.ignoreHostCandidatesFromRemote;
    this.allowIPv6 = !!params.allowIPv6;

    // babel does not like the typescript recipe for multiple extends so we are hacking this one
    // referencing https://github.com/babel/babel/issues/798
    const eventEmitter = new EventEmitter();
    Object.keys((eventEmitter as any).__proto__).forEach((name) => {
      this[name] = eventEmitter[name];
    });

    if (!params.options.optOutOfWebrtcStatsTelemetry) {
      this.setupStatsGatherer();
    }
    this.pc.addEventListener('connectionstatechange', this.onConnectionStateChange.bind(this));
  }

  async onTransportInfo (changes: Jingle, cb: ActionCallback) {
    if (this.ignoreHostCandidatesFromRemote) {
      const transport = (changes.contents?.[0].transport! as JingleIce);
      const nonHostCandidates = transport?.candidates?.filter(candidate => candidate.type !== 'host');

      if (nonHostCandidates?.length !== transport?.candidates?.length) {
        this._log('info', 'Ignoring remote host ice candidates', { conversation: this.conversationId, sessionId: this.sid });

        transport.candidates = nonHostCandidates;
      }
    }

    return super.onTransportInfo(changes, cb);
  }

  setupStatsGatherer () {
    this.statsGatherer = new StatsGatherer(this.pc);
    this.statsGatherer.on('stats', this.emit.bind(this, 'stats'));
  }

  onIceStateChange () {
    const iceState = this.pc.iceConnectionState;
    const sessionId = this.id;
    const conversationId = this.conversationId;

    this._log('info', 'ICE state changed: ', { iceState, sessionId, conversationId });

    if (iceState === 'connected') {
      this._log('info', 'sending session-info: active');
      this.send(JingleAction.SessionInfo, {
        info: {
          infoType: JINGLE_INFO_ACTIVE
        }
      });
    }

    super.onIceStateChange();
  }

  onConnectionStateChange () {
    const sessionId = this.id;
    const conversationId = this.conversationId;
    this._log('info', 'Connection state changed: ', { sessionId, conversationId, connectionState: this.pc.connectionState });
  }

  onIceCandidate (e: RTCPeerConnectionIceEvent) {
    if (e.candidate) {
      if (!this.allowIPv6) {
        const addressRegex = /.+udp [^ ]+ ([^ ]+).*typ host/;
        const matches = addressRegex.exec(e.candidate.candidate);

        const ipv4Regex = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
        if (matches && !matches[1].match(ipv4Regex)) {
          this._log('debug', 'Filtering out IPv6 candidate', e.candidate.candidate);
          return;
        }
      }

      this._log('debug', 'Processing ice candidate', e.candidate.candidate);
    }

    return super.onIceCandidate(e);
  }

  onIceEndOfCandidates () {
    super.onIceEndOfCandidates();
    this.emit('endOfCandidates');
  }

  addTrack (track: MediaStreamTrack, stream?: MediaStream): Promise<void> {
    if (track.kind === 'audio') {
      this.includesAudio = true;
    }
    if (track.kind === 'video') {
      this.includesVideo = true;
    }
    return this.processLocal('addtrack', async () => {
      // find an available sender with the correct type
      const availableTransceiver = this.pc.getTransceivers().find((transceiver) => {
        return !transceiver.sender.track && transceiver.receiver.track?.kind === track.kind;
      });

      if (availableTransceiver) {
        return availableTransceiver.sender.replaceTrack(track);
      }

      this.pc.addTrack(track, stream as MediaStream);
      return;
    });
  }
}

export interface SessionEvents {
  iceConnectionType: ({localCandidateType: string, relayed: boolean, remoteCandidateType: string});
  peerTrackAdded: (track: MediaStreamTrack, stream?: MediaStream) => void;
  peerTrackRemoved: (track: MediaStreamTrack, stream?: MediaStream) => void;
  mute: JingleInfo;
  unmute: JingleInfo;
  sessionState: 'starting' | 'pending' | 'active';
  connectionState: 'starting' | 'connecting' | 'connected' | 'interrupted' | 'disconnected' | 'failed';
  terminated: JingleReason;
  stats: StatsEvent;
  endOfCandidates: void;
}

export interface GenesysCloudMediaSession extends StrictEventEmitter<EventEmitter, SessionEvents> { }
