-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Hôte : 127.0.0.1
-- Généré le : dim. 02 nov. 2025 à 12:00
-- Version du serveur : 10.4.32-MariaDB
-- Version de PHP : 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Base de données : `votux`
--

-- --------------------------------------------------------

--
-- Structure de la table `administrators`
--

CREATE TABLE `administrators` (
  `id` int(11) NOT NULL,
  `email` varchar(150) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `full_name` varchar(100) NOT NULL,
  `role` enum('super_admin','admin') DEFAULT 'admin',
  `is_active` tinyint(1) DEFAULT 1,
  `last_login` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Déchargement des données de la table `administrators`
--

INSERT INTO `administrators` (`id`, `email`, `password_hash`, `full_name`, `role`, `is_active`, `last_login`, `created_at`, `updated_at`) VALUES
(1, 'bayanistone@gmail.com', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Administrateur VOTUX', 'super_admin', 1, NULL, '2025-10-31 22:38:00', '2025-10-31 22:38:00');

-- --------------------------------------------------------

--
-- Structure de la table `candidates`
--

CREATE TABLE `candidates` (
  `id` int(11) NOT NULL,
  `election_id` int(11) NOT NULL,
  `name` varchar(100) NOT NULL,
  `description` text DEFAULT NULL,
  `photo_url` varchar(255) DEFAULT NULL,
  `order_position` int(11) DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Déchargement des données de la table `candidates`
--

INSERT INTO `candidates` (`id`, `election_id`, `name`, `description`, `photo_url`, `order_position`, `created_at`) VALUES
(5, 2, 'Stone', 'Votux', NULL, 1, '2025-10-31 22:45:19'),
(6, 2, 'Zigh', 'MarketApp', NULL, 2, '2025-10-31 22:45:19'),
(7, 2, 'Yann', 'oreniga', NULL, 3, '2025-10-31 22:45:19');

-- --------------------------------------------------------

--
-- Structure de la table `elections`
--

CREATE TABLE `elections` (
  `id` int(11) NOT NULL,
  `title` varchar(200) NOT NULL,
  `description` text DEFAULT NULL,
  `start_date` datetime NOT NULL,
  `end_date` datetime NOT NULL,
  `status` enum('draft','active','completed','cancelled') DEFAULT 'draft',
  `created_by` int(11) DEFAULT NULL,
  `is_public` tinyint(1) DEFAULT 0,
  `max_votes` int(11) DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Déchargement des données de la table `elections`
--

INSERT INTO `elections` (`id`, `title`, `description`, `start_date`, `end_date`, `status`, `created_by`, `is_public`, `max_votes`, `created_at`, `updated_at`) VALUES
(2, 'Votux teste', 'je viens de reactualiser la base de donnees donc je teste d\'abord', '2025-10-31 23:43:00', '2025-10-31 00:00:00', 'active', 1, 0, 1, '2025-10-31 22:45:19', '2025-10-31 23:05:19');

-- --------------------------------------------------------

--
-- Structure de la table `election_admins`
--

CREATE TABLE `election_admins` (
  `id` int(11) NOT NULL,
  `election_id` int(11) NOT NULL,
  `admin_id` int(11) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Structure de la table `election_results`
--

CREATE TABLE `election_results` (
  `id` int(11) NOT NULL,
  `election_id` int(11) DEFAULT NULL,
  `total_votes` int(11) DEFAULT 0,
  `results_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`results_json`)),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `winner_id` int(11) DEFAULT NULL,
  `winner_name` varchar(255) DEFAULT NULL,
  `proclaimed` tinyint(1) DEFAULT 0,
  `proclaimed_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Déchargement des données de la table `election_results`
--

INSERT INTO `election_results` (`id`, `election_id`, `total_votes`, `results_json`, `updated_at`, `winner_id`, `winner_name`, `proclaimed`, `proclaimed_at`) VALUES
(1, 2, 5, '[{\"candidateId\":\"5\",\"candidateName\":\"Stone\",\"votes\":3,\"percentage\":\"60.00\"},{\"candidateId\":\"6\",\"candidateName\":\"Zigh\",\"votes\":1,\"percentage\":\"20.00\"},{\"candidateId\":\"7\",\"candidateName\":\"Yann\",\"votes\":1,\"percentage\":\"20.00\"}]', '2025-10-31 23:09:26', 5, 'Stone', 1, '2025-10-31 23:09:26');

-- --------------------------------------------------------

--
-- Structure de la table `institutions`
--

CREATE TABLE `institutions` (
  `id` int(11) NOT NULL,
  `name` varchar(255) NOT NULL,
  `code` varchar(50) NOT NULL,
  `public_voters_enabled` tinyint(1) DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Déchargement des données de la table `institutions`
--

INSERT INTO `institutions` (`id`, `name`, `code`, `public_voters_enabled`, `created_at`) VALUES
(1, 'Université Omar BONGO', 'UOB', 1, '2025-11-01 19:04:11'),
(2, 'Institut National de la Poste des Technologies de l\'Information et de la Communication', 'INPTIC', 0, '2025-11-01 19:04:11'),
(3, 'Institut National des Sciences de Gestion', 'INSG', 0, '2025-11-01 19:04:11');

-- --------------------------------------------------------

--
-- Structure de la table `voters`
--

CREATE TABLE `voters` (
  `id` int(11) NOT NULL,
  `matricule` varchar(20) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `full_name` varchar(100) NOT NULL,
  `email` varchar(150) DEFAULT NULL,
  `promotion` varchar(50) DEFAULT NULL,
  `faculty` varchar(100) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `activation_token` varchar(255) DEFAULT NULL,
  `activation_expires` datetime DEFAULT NULL,
  `institution_id` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Déchargement des données de la table `voters`
--

INSERT INTO `voters` (`id`, `matricule`, `password_hash`, `full_name`, `email`, `promotion`, `faculty`, `is_active`, `created_at`, `updated_at`, `activation_token`, `activation_expires`, `institution_id`) VALUES
(1, 'ETU001', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Jean Dupont', 'jean.dupont@edu.univ.fr', 'L2 Informatique', NULL, 1, '2025-10-31 22:38:00', '2025-10-31 22:38:00', NULL, NULL, NULL),
(2, 'ETU002', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Marie Martin', 'marie.martin@edu.univ.fr', 'L2 Informatique', NULL, 1, '2025-10-31 22:38:00', '2025-10-31 22:38:00', NULL, NULL, NULL),
(3, 'ETU003', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Pierre Durand', 'pierre.durand@edu.univ.fr', 'M1 Mathématiques', NULL, 1, '2025-10-31 22:38:00', '2025-10-31 22:38:00', NULL, NULL, NULL),
(4, 'ETU004', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Sophie Lambert', 'sophie.lambert@edu.univ.fr', 'L2 Informatique', NULL, 1, '2025-10-31 22:38:00', '2025-10-31 22:38:00', NULL, NULL, NULL),
(5, 'ETU005', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Thomas Moreau', 'thomas.moreau@edu.univ.fr', 'M1 Mathématiques', NULL, 1, '2025-10-31 22:38:00', '2025-10-31 22:38:00', NULL, NULL, NULL),
(6, 'ETU006', '$2b$10$6qVCCGlIDR9.rPpH0iivaeqGAsWlrH2HcACBPWwV3oNPJAGZpcrHa', 'Moussavou Ivane', 'ivan@gmail.com', NULL, NULL, 1, '2025-10-31 23:03:28', '2025-10-31 23:03:28', NULL, NULL, NULL),
(7, 'ETU007', '$2b$10$EZkGAMBTgWrn9/XayLyKh.RPxfpofD1abztIMPo9J1kdfUlVuHJd.', 'Zigh Cheick', NULL, 'GI2B', NULL, 1, '2025-10-31 23:04:37', '2025-10-31 23:04:37', NULL, NULL, NULL),
(8, 'TEST001', '$2b$10$ndzZHXV9gsVB9xeWQ/LKHeBrm4ciEdy7e6zvrauHkoXkWda6WIPVS', 'Electeur Test', 'ezechielstone2005@gmail.com', 'TEST', NULL, 1, '2025-11-01 06:23:47', '2025-11-01 06:26:58', NULL, NULL, NULL);

-- --------------------------------------------------------

--
-- Structure de la table `voting_records`
--

CREATE TABLE `voting_records` (
  `id` int(11) NOT NULL,
  `voter_id` int(11) NOT NULL,
  `election_id` int(11) NOT NULL,
  `has_voted` tinyint(1) DEFAULT 0,
  `voted_at` datetime DEFAULT NULL,
  `session_token` text DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Déchargement des données de la table `voting_records`
--

INSERT INTO `voting_records` (`id`, `voter_id`, `election_id`, `has_voted`, `voted_at`, `session_token`, `ip_address`, `created_at`, `updated_at`) VALUES
(1, 1, 2, 1, '2025-11-01 16:36:00', NULL, NULL, '2025-10-31 22:45:42', '2025-11-01 15:36:00'),
(2, 2, 2, 1, '2025-11-01 00:05:43', NULL, NULL, '2025-10-31 22:45:42', '2025-10-31 23:05:43'),
(3, 4, 2, 0, NULL, NULL, NULL, '2025-10-31 22:45:42', '2025-10-31 22:45:42'),
(4, 3, 2, 1, '2025-11-01 00:07:16', NULL, NULL, '2025-10-31 22:45:42', '2025-10-31 23:07:16'),
(5, 5, 2, 1, '2025-11-01 00:08:54', NULL, NULL, '2025-10-31 22:45:42', '2025-10-31 23:08:54'),
(11, 6, 2, 1, '2025-11-01 00:07:56', NULL, NULL, '2025-10-31 23:03:28', '2025-10-31 23:07:56'),
(12, 7, 2, 1, '2025-11-01 00:06:09', NULL, NULL, '2025-10-31 23:04:37', '2025-10-31 23:06:09');

--
-- Index pour les tables déchargées
--

--
-- Index pour la table `administrators`
--
ALTER TABLE `administrators`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`);

--
-- Index pour la table `candidates`
--
ALTER TABLE `candidates`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_election` (`election_id`);

--
-- Index pour la table `elections`
--
ALTER TABLE `elections`
  ADD PRIMARY KEY (`id`),
  ADD KEY `created_by` (`created_by`),
  ADD KEY `idx_status` (`status`),
  ADD KEY `idx_dates` (`start_date`,`end_date`);

--
-- Index pour la table `election_admins`
--
ALTER TABLE `election_admins`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_ea` (`election_id`,`admin_id`);

--
-- Index pour la table `election_results`
--
ALTER TABLE `election_results`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `election_id` (`election_id`);

--
-- Index pour la table `institutions`
--
ALTER TABLE `institutions`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `code` (`code`);

--
-- Index pour la table `voters`
--
ALTER TABLE `voters`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `matricule` (`matricule`),
  ADD KEY `idx_matricule` (`matricule`),
  ADD KEY `idx_promotion` (`promotion`),
  ADD KEY `idx_voters_institution_id` (`institution_id`);

--
-- Index pour la table `voting_records`
--
ALTER TABLE `voting_records`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_vote` (`voter_id`,`election_id`),
  ADD KEY `election_id` (`election_id`),
  ADD KEY `idx_voter_election` (`voter_id`,`election_id`),
  ADD KEY `idx_has_voted` (`has_voted`);

--
-- AUTO_INCREMENT pour les tables déchargées
--

--
-- AUTO_INCREMENT pour la table `administrators`
--
ALTER TABLE `administrators`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT pour la table `candidates`
--
ALTER TABLE `candidates`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=8;

--
-- AUTO_INCREMENT pour la table `elections`
--
ALTER TABLE `elections`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT pour la table `election_admins`
--
ALTER TABLE `election_admins`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT pour la table `election_results`
--
ALTER TABLE `election_results`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT pour la table `institutions`
--
ALTER TABLE `institutions`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT pour la table `voters`
--
ALTER TABLE `voters`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;

--
-- AUTO_INCREMENT pour la table `voting_records`
--
ALTER TABLE `voting_records`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=13;

--
-- Contraintes pour les tables déchargées
--

--
-- Contraintes pour la table `candidates`
--
ALTER TABLE `candidates`
  ADD CONSTRAINT `candidates_ibfk_1` FOREIGN KEY (`election_id`) REFERENCES `elections` (`id`) ON DELETE CASCADE;

--
-- Contraintes pour la table `elections`
--
ALTER TABLE `elections`
  ADD CONSTRAINT `elections_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `administrators` (`id`);

--
-- Contraintes pour la table `voting_records`
--
ALTER TABLE `voting_records`
  ADD CONSTRAINT `voting_records_ibfk_1` FOREIGN KEY (`voter_id`) REFERENCES `voters` (`id`),
  ADD CONSTRAINT `voting_records_ibfk_2` FOREIGN KEY (`election_id`) REFERENCES `elections` (`id`);
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
