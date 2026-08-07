import type { Request, Response } from 'express';
import type rateLimit from 'express-rate-limit';
import type { LexiconNsid } from '../lexicon/generated.js';
import { authLimiter, registrationLimiter, createLimiter, discoveryLimiter, walletSignLimiter } from './rate-limits.js';
import { isChainModuleEnabled } from '../config.js';
import createCommunity from '../api/net.openfederation.community.create.js';
import getRecord from '../api/com.atproto.repo.getRecord.js';
import resolveHandle from '../api/com.atproto.identity.resolveHandle.js';
import putRecord from '../api/com.atproto.repo.putRecord.js';
import createRecord from '../api/com.atproto.repo.createRecord.js';
import deleteRecord from '../api/com.atproto.repo.deleteRecord.js';
import describeRepo from '../api/com.atproto.repo.describeRepo.js';
import listRecords from '../api/com.atproto.repo.listRecords.js';
import syncGetRepo from '../api/com.atproto.sync.getRepo.js';
import createSession from '../api/com.atproto.server.createSession.js';
import refreshSession from '../api/com.atproto.server.refreshSession.js';
import getSession from '../api/com.atproto.server.getSession.js';
import requestEmailConfirmation from '../api/com.atproto.server.requestEmailConfirmation.js';
import confirmEmail from '../api/com.atproto.server.confirmEmail.js';
import deleteSession from '../api/com.atproto.server.deleteSession.js';
import getServiceAuthEndpoint from '../api/com.atproto.server.getServiceAuth.js';
import registerAccount from '../api/net.openfederation.account.register.js';
import approveAccount from '../api/net.openfederation.account.approve.js';
import rejectAccount from '../api/net.openfederation.account.reject.js';
import listPendingAccounts from '../api/net.openfederation.account.listPending.js';
import createInvite from '../api/net.openfederation.invite.create.js';
import listMyCommunities from '../api/net.openfederation.community.listMine.js';
import getCommunity from '../api/net.openfederation.community.get.js';
import listAllCommunities from '../api/net.openfederation.community.listAll.js';
import updateCommunity from '../api/net.openfederation.community.update.js';
import joinCommunity from '../api/net.openfederation.community.join.js';
import leaveCommunity from '../api/net.openfederation.community.leave.js';
import listMembers from '../api/net.openfederation.community.listMembers.js';
import listJoinRequests from '../api/net.openfederation.community.listJoinRequests.js';
import resolveJoinRequest from '../api/net.openfederation.community.resolveJoinRequest.js';
import exportCommunity from '../api/net.openfederation.community.export.js';
import suspendCommunity from '../api/net.openfederation.community.suspend.js';
import unsuspendCommunity from '../api/net.openfederation.community.unsuspend.js';
import takedownCommunity from '../api/net.openfederation.community.takedown.js';
import transferCommunity from '../api/net.openfederation.community.transfer.js';
import removeMember from '../api/net.openfederation.community.removeMember.js';
import deleteCommunity from '../api/net.openfederation.community.delete.js';
import listAccounts from '../api/net.openfederation.account.list.js';
import listInvites from '../api/net.openfederation.invite.list.js';
import listAudit from '../api/net.openfederation.audit.list.js';
import getServerConfig from '../api/net.openfederation.server.getConfig.js';
import resolveExternal from '../api/net.openfederation.account.resolveExternal.js';
import partnerRegister from '../api/net.openfederation.partner.register.js';
import createPartnerKey from '../api/net.openfederation.partner.createKey.js';
import verifyPartnerKey from '../api/net.openfederation.partner.verifyKey.js';
import listPartnerKeys from '../api/net.openfederation.partner.listKeys.js';
import revokePartnerKey from '../api/net.openfederation.partner.revokeKey.js';
import linkApplication from '../api/net.openfederation.community.linkApplication.js';
import unlinkApplication from '../api/net.openfederation.community.unlinkApplication.js';
import listApplications from '../api/net.openfederation.community.listApplications.js';
import verifyMembership from '../api/net.openfederation.community.verifyMembership.js';
import myCapabilities from '../api/net.openfederation.community.myCapabilities.js';
import updateSubjectStatus from '../api/com.atproto.admin.updateSubjectStatus.js';
import getSubjectStatus from '../api/com.atproto.admin.getSubjectStatus.js';
import adminDeleteAccount from '../api/com.atproto.admin.deleteAccount.js';
import deactivateAccount from '../api/com.atproto.server.deactivateAccount.js';
import activateAccount from '../api/com.atproto.server.activateAccount.js';
import exportAccount from '../api/net.openfederation.account.export.js';
import updateRoles from '../api/net.openfederation.account.updateRoles.js';
import changePassword from '../api/net.openfederation.account.changePassword.js';
import listSessions from '../api/net.openfederation.account.listSessions.js';
import revokeSession from '../api/net.openfederation.account.revokeSession.js';
import requestPasswordReset from '../api/net.openfederation.account.requestPasswordReset.js';
import confirmPasswordReset from '../api/net.openfederation.account.confirmPasswordReset.js';
import getSecurityLevel from '../api/net.openfederation.account.getSecurityLevel.js';
import initiateRecovery from '../api/net.openfederation.account.initiateRecovery.js';
import completeRecovery from '../api/net.openfederation.account.completeRecovery.js';
import getPublicConfig from '../api/net.openfederation.server.getPublicConfig.js';
import listPeers from '../api/net.openfederation.federation.listPeers.js';
import listPeerCommunities from '../api/net.openfederation.federation.listPeerCommunities.js';
import setExternalKey from '../api/net.openfederation.identity.setExternalKey.js';
import listExternalKeys from '../api/net.openfederation.identity.listExternalKeys.js';
import getExternalKey from '../api/net.openfederation.identity.getExternalKey.js';
import deleteExternalKey from '../api/net.openfederation.identity.deleteExternalKey.js';
import resolveByKeyHandler from '../api/net.openfederation.identity.resolveByKey.js';
import getWalletLinkChallenge from '../api/net.openfederation.identity.getWalletLinkChallenge.js';
import linkWallet from '../api/net.openfederation.identity.linkWallet.js';
import unlinkWalletHandler from '../api/net.openfederation.identity.unlinkWallet.js';
import listWalletLinksHandler from '../api/net.openfederation.identity.listWalletLinks.js';
import resolveWalletHandler from '../api/net.openfederation.identity.resolveWallet.js';
import walletProvision from '../api/net.openfederation.wallet.provision.js';
import walletSign from '../api/net.openfederation.wallet.sign.js';
import walletSignTransaction from '../api/net.openfederation.wallet.signTransaction.js';
import signInChallenge from '../api/net.openfederation.identity.signInChallenge.js';
import signInAssert from '../api/net.openfederation.identity.signInAssert.js';
import getPrimaryWallet from '../api/net.openfederation.identity.getPrimaryWallet.js';
import listWalletsPublic from '../api/net.openfederation.identity.listWalletsPublic.js';
import setPrimaryWallet from '../api/net.openfederation.identity.setPrimaryWallet.js';
import getDidAugmentation from '../api/net.openfederation.identity.getDidAugmentation.js';
import walletRetrieveForUpgrade from '../api/net.openfederation.wallet.retrieveForUpgrade.js';
import walletFinalizeTierChange from '../api/net.openfederation.wallet.finalizeTierChange.js';
import walletGrantConsent from '../api/net.openfederation.wallet.grantConsent.js';
import walletRevokeConsent from '../api/net.openfederation.wallet.revokeConsent.js';
import walletListConsents from '../api/net.openfederation.wallet.listConsents.js';
import updateMember from '../api/net.openfederation.community.updateMember.js';
import issueAttestation from '../api/net.openfederation.community.issueAttestation.js';
import deleteAttestation from '../api/net.openfederation.community.deleteAttestation.js';
import listAttestations from '../api/net.openfederation.community.listAttestations.js';
import verifyAttestation from '../api/net.openfederation.community.verifyAttestation.js';
import requestDisclosure from '../api/net.openfederation.attestation.requestDisclosure.js';
import createViewingGrant from '../api/net.openfederation.attestation.createViewingGrant.js';
import verifyCommitment from '../api/net.openfederation.attestation.verifyCommitment.js';
import updateProfile from '../api/net.openfederation.account.updateProfile.js';
import getProfileHandler from '../api/net.openfederation.account.getProfile.js';
import uploadBlob from '../api/com.atproto.repo.uploadBlob.js';
import importRepo from '../api/net.openfederation.admin.importRepo.js';
import createRole from '../api/net.openfederation.community.createRole.js';
import updateRole from '../api/net.openfederation.community.updateRole.js';
import deleteRole from '../api/net.openfederation.community.deleteRole.js';
import listRolesHandler from '../api/net.openfederation.community.listRoles.js';
import setGovernanceModel from '../api/net.openfederation.community.setGovernanceModel.js';
import createProposal from '../api/net.openfederation.community.createProposal.js';
import voteOnProposal from '../api/net.openfederation.community.voteOnProposal.js';
import objectToProposal from '../api/net.openfederation.community.objectToProposal.js';
import listProposals from '../api/net.openfederation.community.listProposals.js';
import getProposalHandler from '../api/net.openfederation.community.getProposal.js';
import amendProposal from '../api/net.openfederation.community.amendProposal.js';
import setDelegation from '../api/net.openfederation.community.setDelegation.js';
import revokeDelegation from '../api/net.openfederation.community.revokeDelegation.js';
import getDelegationHandler from '../api/net.openfederation.community.getDelegation.js';
import createExportSchedule from '../api/net.openfederation.admin.createExportSchedule.js';
import listExportSchedules from '../api/net.openfederation.admin.listExportSchedules.js';
import deleteExportSchedule from '../api/net.openfederation.admin.deleteExportSchedule.js';
import listExportSnapshots from '../api/net.openfederation.admin.listExportSnapshots.js';
import createVerificationChallenge from '../api/net.openfederation.admin.createVerificationChallenge.js';
import verifyChallenge from '../api/net.openfederation.admin.verifyChallenge.js';
// Chain module handlers. This file is one of the two composition roots
// permitted to import a module (see scripts/check-import-boundaries.ts), and
// only ever through the module's public entry point.
import {
  oracleCreateCredential as createOracleCredential,
  oracleListCredentials as listOracleCredentials,
  oracleRevokeCredential as revokeOracleCredential,
  oracleSubmitProof as submitProof,
} from '../modules/chain/index.js';
import vaultRequestShareRelease from '../api/net.openfederation.vault.requestShareRelease.js';
import vaultRegisterEscrow from '../api/net.openfederation.vault.registerEscrow.js';
import vaultExportRecoveryKey from '../api/net.openfederation.vault.exportRecoveryKey.js';
import vaultAuditLog from '../api/net.openfederation.vault.auditLog.js';
import vaultStoreCustodialSecret from '../api/net.openfederation.vault.storeCustodialSecret.js';
import vaultGetCustodialSecret from '../api/net.openfederation.vault.getCustodialSecret.js';
import disclosureRedeemGrant from '../api/net.openfederation.disclosure.redeemGrant.js';
import disclosureGrantStatus from '../api/net.openfederation.disclosure.grantStatus.js';
import disclosureRevokeGrant from '../api/net.openfederation.disclosure.revokeGrant.js';
import disclosureAuditLog from '../api/net.openfederation.disclosure.auditLog.js';
import sendContactRequest from '../api/net.openfederation.contact.sendRequest.js';
import respondToContactRequest from '../api/net.openfederation.contact.respondToRequest.js';
import removeContactHandler from '../api/net.openfederation.contact.removeContact.js';
import listContacts from '../api/net.openfederation.contact.list.js';
import listIncomingContactRequests from '../api/net.openfederation.contact.listIncomingRequests.js';
import listOutgoingContactRequests from '../api/net.openfederation.contact.listOutgoingRequests.js';
import withdrawContactRequest from '../api/net.openfederation.contact.withdrawRequest.js';
import blockContact from '../api/net.openfederation.contact.block.js';
import unblockContact from '../api/net.openfederation.contact.unblock.js';
import listBlocksHandler from '../api/net.openfederation.contact.listBlocks.js';
import listMutualContactsHandler from '../api/net.openfederation.contact.listMutualContacts.js';
import listFriendOfFriendsHandler from '../api/net.openfederation.contact.listFriendOfFriends.js';
import listNotificationsHandler from '../api/net.openfederation.notification.list.js';
import markReadHandler from '../api/net.openfederation.notification.markRead.js';
import unreadCountHandler from '../api/net.openfederation.notification.unreadCount.js';
import createThread from '../api/net.openfederation.forum.createThread.js';
import createPost from '../api/net.openfederation.forum.createPost.js';
import deletePost from '../api/net.openfederation.forum.deletePost.js';
import listThreadsHandler from '../api/net.openfederation.forum.listThreads.js';
import getThreadHandler from '../api/net.openfederation.forum.getThread.js';
import hidePost from '../api/net.openfederation.forum.hidePost.js';
import hideThread from '../api/net.openfederation.forum.hideThread.js';
import createEvent from '../api/net.openfederation.calendar.createEvent.js';
import listEvents from '../api/net.openfederation.calendar.listEvents.js';
import rsvp from '../api/net.openfederation.calendar.rsvp.js';
import listRsvpsHandler from '../api/net.openfederation.calendar.listRsvps.js';

// XRPC Handler type
export type XRPCHandler = (req: Request, res: Response) => Promise<void> | void;
export type HandlerEntry = {
  handler: XRPCHandler;
  limiter?: ReturnType<typeof rateLimit>;
  /**
   * Module-contributed conditional registration. When present, the router
   * checks this before dispatching; a `false` result is treated as the
   * method not existing on this server build (MethodNotImplemented), not
   * as a runtime authorization failure. Purely config-driven — no request
   * state is consulted.
   */
  enabledWhen?: () => boolean;
};

// Static handler registry (frozen after initialization to prevent runtime modification)
const handlers = Object.freeze({
  // Custom OpenFederation methods
  'net.openfederation.community.create': { handler: createCommunity, limiter: createLimiter },
  'net.openfederation.account.register': { handler: registerAccount, limiter: registrationLimiter },
  'net.openfederation.account.approve': { handler: approveAccount },
  'net.openfederation.account.reject': { handler: rejectAccount },
  'net.openfederation.account.listPending': { handler: listPendingAccounts },
  'net.openfederation.invite.create': { handler: createInvite, limiter: createLimiter },
  'net.openfederation.account.list': { handler: listAccounts },
  'net.openfederation.invite.list': { handler: listInvites },
  'net.openfederation.audit.list': { handler: listAudit },
  'net.openfederation.server.getConfig': { handler: getServerConfig },
  'net.openfederation.server.getPublicConfig': { handler: getPublicConfig, limiter: discoveryLimiter },
  'net.openfederation.federation.listPeers': { handler: listPeers, limiter: discoveryLimiter },
  'net.openfederation.federation.listPeerCommunities': { handler: listPeerCommunities, limiter: discoveryLimiter },
  'net.openfederation.account.resolveExternal': { handler: resolveExternal },
  'net.openfederation.community.listMine': { handler: listMyCommunities },
  'net.openfederation.community.get': { handler: getCommunity },
  'net.openfederation.community.listAll': { handler: listAllCommunities },
  'net.openfederation.community.update': { handler: updateCommunity },
  'net.openfederation.community.join': { handler: joinCommunity },
  'net.openfederation.community.leave': { handler: leaveCommunity },
  'net.openfederation.community.listMembers': { handler: listMembers },
  'net.openfederation.community.listJoinRequests': { handler: listJoinRequests },
  'net.openfederation.community.resolveJoinRequest': { handler: resolveJoinRequest },
  'net.openfederation.community.export': { handler: exportCommunity },
  'net.openfederation.community.suspend': { handler: suspendCommunity },
  'net.openfederation.community.unsuspend': { handler: unsuspendCommunity },
  'net.openfederation.community.takedown': { handler: takedownCommunity },
  'net.openfederation.community.transfer': { handler: transferCommunity },
  'net.openfederation.community.removeMember': { handler: removeMember },
  'net.openfederation.community.delete': { handler: deleteCommunity },

  // ActivityPub integration endpoints
  'net.openfederation.community.linkApplication': { handler: linkApplication },
  'net.openfederation.community.unlinkApplication': { handler: unlinkApplication },
  'net.openfederation.community.listApplications': { handler: listApplications },
  'net.openfederation.community.verifyMembership': { handler: verifyMembership },
  'net.openfederation.community.myCapabilities': { handler: myCapabilities },

  // Partner API endpoints
  'net.openfederation.partner.register': { handler: partnerRegister, limiter: registrationLimiter },
  'net.openfederation.partner.createKey': { handler: createPartnerKey },
  'net.openfederation.partner.verifyKey': { handler: verifyPartnerKey },
  'net.openfederation.partner.listKeys': { handler: listPartnerKeys },
  'net.openfederation.partner.revokeKey': { handler: revokePartnerKey },

  // External identity key endpoints
  'net.openfederation.identity.setExternalKey': { handler: setExternalKey },
  'net.openfederation.identity.listExternalKeys': { handler: listExternalKeys, limiter: discoveryLimiter },
  'net.openfederation.identity.getExternalKey': { handler: getExternalKey, limiter: discoveryLimiter },
  'net.openfederation.identity.deleteExternalKey': { handler: deleteExternalKey },
  'net.openfederation.identity.resolveByKey': { handler: resolveByKeyHandler, limiter: discoveryLimiter },

  // Wallet linking endpoints
  'net.openfederation.identity.getWalletLinkChallenge': { handler: getWalletLinkChallenge, limiter: createLimiter },
  'net.openfederation.identity.linkWallet': { handler: linkWallet, limiter: createLimiter },
  'net.openfederation.identity.unlinkWallet': { handler: unlinkWalletHandler },
  'net.openfederation.identity.listWalletLinks': { handler: listWalletLinksHandler },
  'net.openfederation.identity.resolveWallet': { handler: resolveWalletHandler, limiter: discoveryLimiter },

  // Progressive-custody wallet provisioning + custodial signing (Tier 1)
  'net.openfederation.wallet.provision': { handler: walletProvision, limiter: createLimiter },
  'net.openfederation.wallet.sign': { handler: walletSign, limiter: walletSignLimiter },
  'net.openfederation.wallet.signTransaction': { handler: walletSignTransaction, limiter: walletSignLimiter },

  // Sign-In With OpenFederation (SIWOF)
  'net.openfederation.identity.signInChallenge': { handler: signInChallenge, limiter: createLimiter },
  'net.openfederation.identity.signInAssert': { handler: signInAssert, limiter: walletSignLimiter },

  // Public DID→wallet resolver + DID document augmentation (unauthenticated).
  'net.openfederation.identity.getPrimaryWallet': { handler: getPrimaryWallet, limiter: discoveryLimiter },
  'net.openfederation.identity.listWalletsPublic': { handler: listWalletsPublic, limiter: discoveryLimiter },
  'net.openfederation.identity.setPrimaryWallet': { handler: setPrimaryWallet },
  'net.openfederation.identity.getDidAugmentation': { handler: getDidAugmentation, limiter: discoveryLimiter },

  // Progressive-custody tier upgrades (1 → 2, 1 → 3, 2 → 3). authLimiter
  // enforces a stricter throttle on password-backed operations.
  'net.openfederation.wallet.retrieveForUpgrade': { handler: walletRetrieveForUpgrade, limiter: authLimiter },
  'net.openfederation.wallet.finalizeTierChange': { handler: walletFinalizeTierChange, limiter: authLimiter },

  'net.openfederation.wallet.grantConsent': { handler: walletGrantConsent, limiter: createLimiter },
  'net.openfederation.wallet.revokeConsent': { handler: walletRevokeConsent },
  'net.openfederation.wallet.listConsents': { handler: walletListConsents },

  // Community role management
  'net.openfederation.community.updateMember': { handler: updateMember },

  // Community role CRUD
  'net.openfederation.community.createRole': { handler: createRole },
  'net.openfederation.community.updateRole': { handler: updateRole },
  'net.openfederation.community.deleteRole': { handler: deleteRole },
  'net.openfederation.community.listRoles': { handler: listRolesHandler, limiter: discoveryLimiter },

  // Governance model and voting
  'net.openfederation.community.setGovernanceModel': { handler: setGovernanceModel },
  'net.openfederation.community.createProposal': { handler: createProposal },
  'net.openfederation.community.voteOnProposal': { handler: voteOnProposal },
  'net.openfederation.community.objectToProposal': { handler: objectToProposal },
  'net.openfederation.community.listProposals': { handler: listProposals, limiter: discoveryLimiter },
  'net.openfederation.community.getProposal': { handler: getProposalHandler, limiter: discoveryLimiter },
  'net.openfederation.community.amendProposal': { handler: amendProposal },

  // Delegation
  'net.openfederation.community.setDelegation': { handler: setDelegation },
  'net.openfederation.community.revokeDelegation': { handler: revokeDelegation },
  'net.openfederation.community.getDelegation': { handler: getDelegationHandler, limiter: discoveryLimiter },

  // Export scheduler admin
  'net.openfederation.admin.createExportSchedule': { handler: createExportSchedule },
  'net.openfederation.admin.listExportSchedules': { handler: listExportSchedules },
  'net.openfederation.admin.deleteExportSchedule': { handler: deleteExportSchedule },
  'net.openfederation.admin.listExportSnapshots': { handler: listExportSnapshots },

  // Community attestation endpoints
  'net.openfederation.community.issueAttestation': { handler: issueAttestation },
  'net.openfederation.community.deleteAttestation': { handler: deleteAttestation },
  'net.openfederation.community.listAttestations': { handler: listAttestations, limiter: discoveryLimiter },
  'net.openfederation.community.verifyAttestation': { handler: verifyAttestation, limiter: discoveryLimiter },

  // Encrypted attestation disclosure endpoints
  'net.openfederation.attestation.requestDisclosure': { handler: requestDisclosure },
  'net.openfederation.attestation.createViewingGrant': { handler: createViewingGrant },
  'net.openfederation.attestation.verifyCommitment': { handler: verifyCommitment, limiter: discoveryLimiter },

  // Profile endpoints
  'net.openfederation.account.updateProfile': { handler: updateProfile },
  'net.openfederation.account.getProfile': { handler: getProfileHandler, limiter: discoveryLimiter },

  // OpenFederation account lifecycle
  'net.openfederation.account.export': { handler: exportAccount },
  'net.openfederation.account.updateRoles': { handler: updateRoles },
  'net.openfederation.account.changePassword': { handler: changePassword, limiter: authLimiter },
  'net.openfederation.account.listSessions': { handler: listSessions },
  'net.openfederation.account.revokeSession': { handler: revokeSession },
  'net.openfederation.account.requestPasswordReset': { handler: requestPasswordReset, limiter: authLimiter },
  'net.openfederation.account.confirmPasswordReset': { handler: confirmPasswordReset, limiter: authLimiter },
  'net.openfederation.account.getSecurityLevel': { handler: getSecurityLevel },
  'net.openfederation.account.initiateRecovery': { handler: initiateRecovery, limiter: authLimiter },
  'net.openfederation.account.completeRecovery': { handler: completeRecovery, limiter: authLimiter },

  // Standard ATProto admin endpoints
  'com.atproto.admin.updateSubjectStatus': { handler: updateSubjectStatus },
  'com.atproto.admin.getSubjectStatus': { handler: getSubjectStatus },
  'com.atproto.admin.deleteAccount': { handler: adminDeleteAccount },

  // Standard ATProto endpoints
  'com.atproto.server.deactivateAccount': { handler: deactivateAccount },
  'com.atproto.server.activateAccount': { handler: activateAccount },
  'com.atproto.server.createSession': { handler: createSession, limiter: authLimiter },
  'com.atproto.server.refreshSession': { handler: refreshSession, limiter: authLimiter },
  'com.atproto.server.getSession': { handler: getSession },
  // Resends are rate-limited like other creation-ish actions; confirm is
  // token-authenticated by design and needs no session (#83).
  'com.atproto.server.requestEmailConfirmation': { handler: requestEmailConfirmation, limiter: createLimiter },
  'com.atproto.server.confirmEmail': { handler: confirmEmail },
  'com.atproto.server.deleteSession': { handler: deleteSession },
  'com.atproto.server.getServiceAuth': { handler: getServiceAuthEndpoint },
  'com.atproto.identity.resolveHandle': { handler: resolveHandle, limiter: discoveryLimiter },
  'com.atproto.repo.getRecord': { handler: getRecord },
  'com.atproto.repo.putRecord': { handler: putRecord },
  'com.atproto.repo.createRecord': { handler: createRecord },
  'com.atproto.repo.deleteRecord': { handler: deleteRecord },
  'com.atproto.repo.describeRepo': { handler: describeRepo },
  'com.atproto.repo.listRecords': { handler: listRecords },
  'com.atproto.sync.getRepo': { handler: syncGetRepo },
  'com.atproto.repo.uploadBlob': { handler: uploadBlob },

  // Admin repo management
  'net.openfederation.admin.importRepo': { handler: importRepo },

  // Admin identity verification challenge
  'net.openfederation.admin.createVerificationChallenge': { handler: createVerificationChallenge },
  'net.openfederation.admin.verifyChallenge': { handler: verifyChallenge },

  // Oracle credential management (admin only) — chain-module surface; gated
  // behind isChainModuleEnabled() (see src/config.ts). A pure-federation PDS
  // carries zero chain surface, so these register only when the chain
  // module is activated (CHAIN_ADAPTERS or GOVERNANCE_CHAIN_ENABLED=true).
  'net.openfederation.oracle.createCredential': { handler: createOracleCredential, enabledWhen: isChainModuleEnabled },
  'net.openfederation.oracle.listCredentials': { handler: listOracleCredentials, enabledWhen: isChainModuleEnabled },
  'net.openfederation.oracle.revokeCredential': { handler: revokeOracleCredential, enabledWhen: isChainModuleEnabled },

  // Oracle proof verification
  'net.openfederation.oracle.submitProof': { handler: submitProof, enabledWhen: isChainModuleEnabled },

  // Vault service — threshold key custody
  'net.openfederation.vault.requestShareRelease': { handler: vaultRequestShareRelease, limiter: authLimiter },
  'net.openfederation.vault.registerEscrow': { handler: vaultRegisterEscrow },
  'net.openfederation.vault.exportRecoveryKey': { handler: vaultExportRecoveryKey, limiter: authLimiter },
  'net.openfederation.vault.auditLog': { handler: vaultAuditLog },
  'net.openfederation.vault.storeCustodialSecret': { handler: vaultStoreCustodialSecret },
  'net.openfederation.vault.getCustodialSecret': { handler: vaultGetCustodialSecret },

  // Disclosure proxy — time-limited access with watermarking
  'net.openfederation.disclosure.redeemGrant': { handler: disclosureRedeemGrant },
  'net.openfederation.disclosure.grantStatus': { handler: disclosureGrantStatus },
  'net.openfederation.disclosure.revokeGrant': { handler: disclosureRevokeGrant },
  'net.openfederation.disclosure.auditLog': { handler: disclosureAuditLog },

  // Contact graph
  'net.openfederation.contact.sendRequest': { handler: sendContactRequest },
  'net.openfederation.contact.respondToRequest': { handler: respondToContactRequest },
  'net.openfederation.contact.removeContact': { handler: removeContactHandler },
  'net.openfederation.contact.withdrawRequest': { handler: withdrawContactRequest },
  'net.openfederation.contact.list': { handler: listContacts },
  'net.openfederation.contact.listIncomingRequests': { handler: listIncomingContactRequests },
  'net.openfederation.contact.listOutgoingRequests': { handler: listOutgoingContactRequests },
  'net.openfederation.contact.block': { handler: blockContact },
  'net.openfederation.contact.unblock': { handler: unblockContact },
  'net.openfederation.contact.listBlocks': { handler: listBlocksHandler },
  'net.openfederation.contact.listMutualContacts': { handler: listMutualContactsHandler },
  'net.openfederation.contact.listFriendOfFriends': { handler: listFriendOfFriendsHandler },

  // Forum
  'net.openfederation.forum.createThread': { handler: createThread, limiter: createLimiter },
  'net.openfederation.forum.createPost': { handler: createPost, limiter: createLimiter },
  'net.openfederation.forum.deletePost': { handler: deletePost },
  'net.openfederation.forum.hidePost': { handler: hidePost },
  'net.openfederation.forum.hideThread': { handler: hideThread },
  'net.openfederation.forum.listThreads': { handler: listThreadsHandler, limiter: discoveryLimiter },
  'net.openfederation.forum.getThread': { handler: getThreadHandler, limiter: discoveryLimiter },

  // Calendar
  'net.openfederation.calendar.createEvent': { handler: createEvent, limiter: createLimiter },
  'net.openfederation.calendar.listEvents': { handler: listEvents, limiter: discoveryLimiter },
  'net.openfederation.calendar.rsvp': { handler: rsvp, limiter: createLimiter },
  'net.openfederation.calendar.listRsvps': { handler: listRsvpsHandler, limiter: discoveryLimiter },

  // Notifications
  'net.openfederation.notification.list': { handler: listNotificationsHandler },
  'net.openfederation.notification.markRead': { handler: markReadHandler },
  'net.openfederation.notification.unreadCount': { handler: unreadCountHandler },
} satisfies Readonly<Partial<Record<LexiconNsid, HandlerEntry>>>);

export const handlerRegistry: Readonly<Record<string, HandlerEntry | undefined>> = handlers;
