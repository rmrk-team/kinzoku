// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IKanaria {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title KinzokuV2 - Serverless metal plate claims for Kanaria Founders
/// @notice Encrypted shipping data stored on-chain, only owner can decrypt
contract KinzokuV2 {
    address public immutable owner;
    IKanaria public immutable kanaria;
    uint256 public constant MAX_ID = 99;

    enum Status { Unclaimed, Pending, Shipped }

    struct Claim {
        address claimant;
        Status status;
        string encryptedPayload; // NaCl sealed box: {address, contact, type}
    }

    mapping(uint256 => Claim) public claims;

    event Claimed(uint256 indexed nftId, address indexed claimant);
    event StatusChanged(uint256 indexed nftId, Status status);

    error NotOwner();
    error NotTokenOwner();
    error InvalidNftId();
    error AlreadyClaimed();
    error EmptyPayload();

    /// @param _owner The address allowed to mark shipped/reset/migrate (do NOT rely on msg.sender when deploying via CREATE2 factory)
    /// @param _kanaria The Kanaria Founders ERC-721 contract address
    constructor(address _owner, address _kanaria) {
        owner = _owner;
        kanaria = IKanaria(_kanaria);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyTokenOwner(uint256 nftId) {
        if (msg.sender != kanaria.ownerOf(nftId)) revert NotTokenOwner();
        _;
    }

    modifier validId(uint256 nftId) {
        if (nftId == 0 || nftId > MAX_ID) revert InvalidNftId();
        _;
    }

    /// @notice Claim a metal plate for an NFT you own
    /// @param nftId The Kanaria Founder NFT ID (1-99)
    /// @param encryptedPayload NaCl sealed box with shipping info
    function claim(
        uint256 nftId,
        string calldata encryptedPayload
    ) external onlyTokenOwner(nftId) validId(nftId) {
        if (claims[nftId].status != Status.Unclaimed) revert AlreadyClaimed();
        if (bytes(encryptedPayload).length == 0) revert EmptyPayload();
        
        claims[nftId] = Claim({
            claimant: msg.sender,
            status: Status.Pending,
            encryptedPayload: encryptedPayload
        });

        emit Claimed(nftId, msg.sender);
    }

    /// @notice Owner marks NFT as shipped
    function markShipped(uint256 nftId) external onlyOwner validId(nftId) {
        claims[nftId].status = Status.Shipped;
        emit StatusChanged(nftId, Status.Shipped);
    }

    /// @notice Owner batch marks NFTs as shipped
    function batchMarkShipped(uint256[] calldata nftIds) external onlyOwner {
        for (uint256 i = 0; i < nftIds.length; i++) {
            uint256 nftId = nftIds[i];
            if (nftId > 0 && nftId <= MAX_ID) {
                claims[nftId].status = Status.Shipped;
                emit StatusChanged(nftId, Status.Shipped);
            }
        }
    }

    /// @notice Owner resets a claim (if someone needs to resubmit)
    function resetClaim(uint256 nftId) external onlyOwner validId(nftId) {
        delete claims[nftId];
        emit StatusChanged(nftId, Status.Unclaimed);
    }

    /// @notice Owner can pre-mark NFTs as shipped (for migration from v1)
    function batchPremark(uint256[] calldata nftIds) external onlyOwner {
        for (uint256 i = 0; i < nftIds.length; i++) {
            uint256 nftId = nftIds[i];
            if (nftId > 0 && nftId <= MAX_ID && claims[nftId].status == Status.Unclaimed) {
                claims[nftId].status = Status.Shipped;
                emit StatusChanged(nftId, Status.Shipped);
            }
        }
    }

    /// @notice Get all NFT owners (for UI)
    function getAllOwners() external view returns (address[99] memory owners) {
        for (uint256 i = 1; i <= 99; i++) {
            if (i == 67 || i == 87 || i == 92) {
                owners[i - 1] = address(0); // Dead eggs
            } else {
                try kanaria.ownerOf(i) returns (address o) {
                    owners[i - 1] = o;
                } catch {
                    owners[i - 1] = address(0);
                }
            }
        }
    }

    /// @notice Get all statuses (for UI)
    function getAllStatuses() external view returns (Status[99] memory statuses) {
        for (uint256 i = 1; i <= 99; i++) {
            statuses[i - 1] = claims[i].status;
        }
    }

    /// @notice Get all claims with encrypted payloads (for owner's fetch script)
    function getAllClaims() external view returns (
        address[99] memory claimants,
        Status[99] memory statuses,
        string[99] memory payloads
    ) {
        for (uint256 i = 1; i <= 99; i++) {
            Claim storage c = claims[i];
            claimants[i - 1] = c.claimant;
            statuses[i - 1] = c.status;
            payloads[i - 1] = c.encryptedPayload;
        }
    }

    /// @notice Get single claim
    function getClaim(uint256 nftId) external view validId(nftId) returns (
        address claimant,
        Status status,
        string memory encryptedPayload
    ) {
        Claim storage c = claims[nftId];
        return (c.claimant, c.status, c.encryptedPayload);
    }
}
