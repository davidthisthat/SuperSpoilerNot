const fs = require('fs');
const path = require('path');

// Konfiguration - Interne SRF API (keine Auth nötig!)
const API_BASE = 'https://il.srgssr.ch/integrationlayer/2.0/srf/searchResultMediaList';
const LINKS_FILE = path.join(__dirname, 'links.json');
const TEAMS_FILE = path.join(__dirname, 'teams.json');
const SPIELPLAN_FILE = path.join(__dirname, 'spielplan.json');

// Lade JSON-Dateien
function loadJSON(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.error(`Fehler beim Laden von ${filePath}:`, error.message);
        return null;
    }
}

// Speichere JSON-Datei
function saveJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// API-Suche nach Videos
async function searchVideos(query) {
    const url = `${API_BASE}?q=${encodeURIComponent(query)}`;
    
    console.log(`  API-Suche: "${query}"`);
    
    const response = await fetch(url);
    
    if (!response.ok) {
        console.error(`  API-Fehler: ${response.status} ${response.statusText}`);
        return [];
    }
    
    const data = await response.json();
    return data.searchResultMediaList || [];
}

// Prüfe ob ein Team-Keyword im Text vorkommt
function findTeamInText(text, teamName, teamsData) {
    const textLower = text.toLowerCase();
    
    // Prüfe Team-Keywords
    const teamInfo = teamsData.teams[teamName];
    if (teamInfo && teamInfo.keywords) {
        for (const keyword of teamInfo.keywords) {
            if (textLower.includes(keyword.toLowerCase())) {
                return true;
            }
        }
    }
    
    // Prüfe auch den Teamnamen selbst
    if (textLower.includes(teamName.toLowerCase())) {
        return true;
    }
    
    return false;
}

// Finde ein passendes Keyword für die Suche
function getSearchKeyword(teamName, teamsData) {
    const teamInfo = teamsData.teams[teamName];
    if (teamInfo && teamInfo.keywords && teamInfo.keywords.length > 0) {
        return teamInfo.keywords[0];
    }
    return teamName;
}

// Finde Spiele die gesucht werden müssen
function getMatchesToSearch(spielplan, links, testMatchday = null) {
    const now = new Date();
    const matchesToSearch = [];
    const MAX_SEARCH_HOURS = 6; // Maximal 6 Stunden nach searchStart suchen
    
    for (const matchday of spielplan.matchdays) {
        if (testMatchday !== null && matchday.matchday !== testMatchday) {
            continue;
        }
        
        for (const match of matchday.matches) {
            const matchKey = `${match.home} - ${match.away}`;
            
            // Überspringe wenn Link bereits gefunden
            if (links.matches[matchKey] && links.matches[matchKey].url) {
                continue;
            }
            
            // Im Test-Modus: Ignoriere searchStart
            if (testMatchday !== null) {
                matchesToSearch.push({
                    matchday: matchday.matchday,
                    ...match,
                    matchKey
                });
                continue;
            }
            
            // Prüfe ob Suchzeit erreicht ist UND nicht zu alt
            if (match.searchStart) {
                const searchTime = new Date(match.searchStart);
                const searchEndTime = new Date(searchTime.getTime() + MAX_SEARCH_HOURS * 60 * 60 * 1000);
                
                if (now >= searchTime && now <= searchEndTime) {
                    matchesToSearch.push({
                        matchday: matchday.matchday,
                        ...match,
                        matchKey
                    });
                } else if (now > searchEndTime) {
                    console.log(`  ⏰ Timeout: ${matchKey} (Suche beendet nach ${MAX_SEARCH_HOURS}h)`);
                }
            }
        }
    }
    
    return matchesToSearch;
}

// Baue die SRF Video-URL
function buildVideoUrl(urn) {
    return `https://www.srf.ch/play/tv/-/video/-?urn=${urn}`;
}

// Hauptfunktion
async function crawl() {
    console.log('=== SRF Super League Crawler ===');
    console.log(`Zeit: ${new Date().toISOString()}`);
    
    // Lade Daten
    const teams = loadJSON(TEAMS_FILE);
    const spielplan = loadJSON(SPIELPLAN_FILE);
    let links = loadJSON(LINKS_FILE);
    
    if (!teams || !spielplan) {
        console.error('Konnte teams.json oder spielplan.json nicht laden');
        process.exit(1);
    }
    
    // Initialisiere links.json falls nicht vorhanden
    if (!links) {
        links = { lastUpdated: new Date().toISOString(), matches: {} };
    }
    
    // Prüfe auf --test Flag mit optionalem Spieltag
    let testMatchday = null;
    const testIndex = process.argv.indexOf('--test');
    if (testIndex !== -1) {
        const nextArg = process.argv[testIndex + 1];
        if (nextArg && !nextArg.startsWith('-')) {
            testMatchday = parseInt(nextArg, 10);
        } else {
            testMatchday = 22;
        }
        console.log(`TEST-MODUS: Suche Spieltag ${testMatchday}`);
    }
    
    // Finde Spiele zum Suchen
    const matchesToSearch = getMatchesToSearch(spielplan, links, testMatchday);
    
    if (matchesToSearch.length === 0) {
        console.log('Keine Spiele zum Suchen.');
        return;
    }
    
    console.log(`\nSuche nach ${matchesToSearch.length} Spielen:`);
    matchesToSearch.forEach(m => console.log(`  - ${m.matchKey}`));
    
    let foundCount = 0;
    
    for (const match of matchesToSearch) {
        console.log(`\n--- ${match.matchKey} ---`);
        
        // Suche mit dem Home-Team Keyword
        const homeKeyword = getSearchKeyword(match.home, teams);
        const results = await searchVideos(homeKeyword);
        
        console.log(`  Gefunden: ${results.length} Videos`);
        
        // Durchsuche die Ergebnisse - zuerst Sport-Clip (Standalone), dann Sendung als Fallback
        let standaloneMatch = null;
        let sendungMatch = null;
        
        for (const video of results) {
            const title = video.title || '';
            const description = video.description || '';
            const showTitle = video.show?.title || '';
            const fullText = `${title} ${description} ${showTitle}`;
            
            // Prüfe ob mindestens ein Team erwähnt wird
            const homeFound = findTeamInText(fullText, match.home, teams);
            const awayFound = findTeamInText(fullText, match.away, teams);
            
            if (homeFound || awayFound) {
                // Sport-Clip = Standalone (bevorzugt)
                if (showTitle === 'Sport-Clip' && !standaloneMatch) {
                    standaloneMatch = video;
                }
                // Super League Highlights = Sendung (Fallback)
                else if (showTitle.includes('Super League') && !sendungMatch) {
                    sendungMatch = video;
                }
            }
            
            // Wenn Standalone gefunden, können wir aufhören
            if (standaloneMatch) break;
        }
        
        // Bevorzuge Standalone, sonst Sendung
        const foundVideo = standaloneMatch || sendungMatch;
        
        if (foundVideo) {
            const videoUrl = buildVideoUrl(foundVideo.urn);
            const videoType = standaloneMatch ? 'Standalone' : 'Sendung';
            
            console.log(`  ✓ GEFUNDEN (${videoType}): ${foundVideo.title}`);
            console.log(`    URL: ${videoUrl}`);
            
            links.matches[match.matchKey] = {
                url: videoUrl,
                foundAt: new Date().toISOString(),
                title: foundVideo.title,
                urn: foundVideo.urn,
                type: videoType
            };
            foundCount++;
        }
        
        // Falls nicht gefunden, zweiter Versuch mit Away-Team
        if (!links.matches[match.matchKey]?.url) {
            const awayKeyword = getSearchKeyword(match.away, teams);
            if (awayKeyword !== homeKeyword) {
                const results2 = await searchVideos(awayKeyword);
                console.log(`  Zweite Suche (${awayKeyword}): ${results2.length} Videos`);
                
                let standaloneMatch2 = null;
                let sendungMatch2 = null;
                
                for (const video of results2) {
                    const title = video.title || '';
                    const description = video.description || '';
                    const showTitle = video.show?.title || '';
                    const fullText = `${title} ${description} ${showTitle}`;
                    
                    const homeFound = findTeamInText(fullText, match.home, teams);
                    const awayFound = findTeamInText(fullText, match.away, teams);
                    
                    if (homeFound || awayFound) {
                        if (showTitle === 'Sport-Clip' && !standaloneMatch2) {
                            standaloneMatch2 = video;
                        } else if (showTitle.includes('Super League') && !sendungMatch2) {
                            sendungMatch2 = video;
                        }
                    }
                    
                    if (standaloneMatch2) break;
                }
                
                const foundVideo2 = standaloneMatch2 || sendungMatch2;
                
                if (foundVideo2) {
                    const videoUrl = buildVideoUrl(foundVideo2.urn);
                    const videoType = standaloneMatch2 ? 'Standalone' : 'Sendung';
                    
                    console.log(`  ✓ GEFUNDEN (${videoType}): ${foundVideo2.title}`);
                    console.log(`    URL: ${videoUrl}`);
                    
                    links.matches[match.matchKey] = {
                        url: videoUrl,
                        foundAt: new Date().toISOString(),
                        title: foundVideo2.title,
                        urn: foundVideo2.urn,
                        type: videoType
                    };
                    foundCount++;
                }
            }
        }
        
        if (!links.matches[match.matchKey]?.url) {
            console.log(`  ✗ Nicht gefunden`);
        }
        
        // Kurze Pause zwischen API-Calls
        await new Promise(r => setTimeout(r, 300));
    }
    
    // Speichere Ergebnisse
    if (foundCount > 0) {
        links.lastUpdated = new Date().toISOString();
        saveJSON(LINKS_FILE, links);
        console.log(`\n${foundCount} neue Links gespeichert in links.json`);
    } else {
        console.log('\nKeine neuen Links gefunden');
    }
}

// Starte Crawler
crawl().catch(error => {
    console.error('Crawler-Fehler:', error);
    process.exit(1);
});
