// STUN works for most networks; a TURN server is needed when both sides are
// behind strict NATs. Configure one with TURN_URL / TURN_USERNAME / TURN_CREDENTIAL.
export const getIceServers = (req, res) => {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  const { TURN_URL, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
  if (TURN_URL && TURN_USERNAME && TURN_CREDENTIAL) {
    iceServers.push({
      urls: TURN_URL.split(",").map((url) => url.trim()),
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    });
  }

  return res.status(200).json({ iceServers });
};
