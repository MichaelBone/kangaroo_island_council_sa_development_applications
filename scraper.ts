// Parses the development applications at the South Australian Kangaroo Island Council web site
// and places them in a database.
//
// Michael Bone
// 28th February 2019

"use strict";

import * as fs from "fs";
import * as cheerio from "cheerio";
import * as request from "request-promise-native";
import * as sqlite3 from "sqlite3";
import * as urlparser from "url";
import * as moment from "moment";
import * as pdfjs from "pdfjs-dist";
import didYouMean, * as didyoumean from "didyoumean2";

sqlite3.verbose();

const DevelopmentApplicationsUrl = "https://www.kangarooisland.sa.gov.au/page.aspx?u=1646";
const CommentUrl = "mailto:kicouncil@kicouncil.sa.gov.au";

declare const process: any;

// All valid street names, street suffixes, suburb names and hundred names.

let StreetNames = null;
let StreetSuffixes = null;
let SuburbNames = null;
let HundredNames = null;

// Sets up an sqlite database.

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text, [legal_description] text)");
            resolve(database);
        });
    });
}

// Inserts a row in the database if the row does not already exist.

async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate,
            developmentApplication.legalDescription
        ], function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\", legal description \"${developmentApplication.legalDescription}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\", legal description \"${developmentApplication.legalDescription}\" and received date \"${developmentApplication.receivedDate}\" because it was already present in the database.`);
                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// A bounding rectangle.

interface Rectangle {
    x: number,
    y: number,
    width: number,
    height: number
}

// An element (consisting of text and a bounding rectangle) in a PDF document.

interface Element extends Rectangle {
    text: string
}

// Constructs a rectangle based on the intersection of the two specified rectangles.

function intersect(rectangle1: Rectangle, rectangle2: Rectangle): Rectangle {
    let x1 = Math.max(rectangle1.x, rectangle2.x);
    let y1 = Math.max(rectangle1.y, rectangle2.y);
    let x2 = Math.min(rectangle1.x + rectangle1.width, rectangle2.x + rectangle2.width);
    let y2 = Math.min(rectangle1.y + rectangle1.height, rectangle2.y + rectangle2.height);
    if (x2 >= x1 && y2 >= y1)
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    else
        return { x: 0, y: 0, width: 0, height: 0 };
}

// Calculates the fraction of an element that lies within a rectangle (as a percentage).  For
// example, if a quarter of the specifed element lies within the specified rectangle then this
// would return 25.

function getPercentageOfElementInRectangle(element: Element, rectangle: Rectangle) {
    let elementArea = getArea(element);
    let intersectionArea = getArea(intersect(rectangle, element));
    return (elementArea === 0) ? 0 : ((intersectionArea * 100) / elementArea);
}

// Calculates the area of a rectangle.

function getArea(rectangle: Rectangle) {
    return rectangle.width * rectangle.height;
}

// Formats (and corrects) an address.

function formatAddress(address: string) {
    address = address.trim();
    if (address.startsWith("LOT:"))
        return "";
    else if (address.startsWith("No Residential Address"))
        return "";
    else if (/^\d,\d\d\d/.test(address))
        return address.substring(0, 1) + address.substring(2);  // remove the comma
    else if (/^\d\d,\d\d\d/.test(address))
        return address.substring(0, 2) + address.substring(3);  // remove the comma
    else
        return address;
}

// Parses the details from the elements associated with a single page of the PDF (corresponding
// to a single development application).

function parseApplicationElements(elements: Element[], informationUrl: string) {
    // Get the application number (by finding all elements that are at least 10% within the
    // calculated bounding rectangle).

    let applicationNumberHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "").startsWith("applicationno"));
    let fullDevelopmentApprovalHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "fulldevelopmentapproval");
    let applicationReceivedHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "applicationreceived");
    if (applicationReceivedHeadingElement === undefined)
        applicationReceivedHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "applicationrdate");
    let developmentDescriptionHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "developmentdescription");
    let relevantAuthorityHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "relevantauthority");
    let houseNumberHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "houseno");
    let lotNumberHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "lotno");
    let sectionNumberHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "sectionno");
    let planIdHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "planid");
    let propertyStreetHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "propertystreet");
    let propertySuburbHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "propertysuburb");
    let titleHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "title");
    let hundredHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "hundredof");
    
    if (applicationNumberHeadingElement === undefined) {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Ignoring the page because the "Application No" text is missing.  Elements: ${elementSummary}`);
        return undefined;
    }

    // Get the application number.

    let applicationNumberBounds: Rectangle = {
        x: applicationNumberHeadingElement.x + applicationNumberHeadingElement.width,
        y: applicationNumberHeadingElement.y,
        width: (fullDevelopmentApprovalHeadingElement === undefined) ? (applicationNumberHeadingElement.width * 2) : (fullDevelopmentApprovalHeadingElement.x - applicationNumberHeadingElement.x - applicationNumberHeadingElement.width),
        height: applicationNumberHeadingElement.height
    };
    let applicationNumberElement = elements.find(element => getPercentageOfElementInRectangle(element, applicationNumberBounds) > 10);
    let applicationNumber = (applicationNumberElement === undefined) ? "" : applicationNumberElement.text.replace(/\s/g, "");
    
    if (applicationNumber === "") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find the application number on the PDF page for the current development application.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }

    console.log(`    Found \"${applicationNumber}\".`);

    // Get the received date.

    let receivedDateBounds: Rectangle = {
        x: applicationReceivedHeadingElement.x + applicationReceivedHeadingElement.width,
        y: applicationReceivedHeadingElement.y,
        width: (fullDevelopmentApprovalHeadingElement === undefined) ? (applicationReceivedHeadingElement.width * 2) : (fullDevelopmentApprovalHeadingElement.x - applicationReceivedHeadingElement.x - applicationReceivedHeadingElement.width),
        height: applicationReceivedHeadingElement.height
    };
    let receivedDateElement = elements.find(element => getPercentageOfElementInRectangle(element, receivedDateBounds) > 10);
    let receivedDate = moment.invalid();
    if (receivedDateElement !== undefined)
        receivedDate = moment(receivedDateElement.text.trim(), "D/MM/YYYY", true);  // allows the leading zero of the day to be omitted

    // Get the description.

    let descriptionBounds: Rectangle = {
        x: developmentDescriptionHeadingElement.x + developmentDescriptionHeadingElement.width,
        y: developmentDescriptionHeadingElement.y,
        width: (fullDevelopmentApprovalHeadingElement === undefined) ? Number.MAX_VALUE : (fullDevelopmentApprovalHeadingElement.x - developmentDescriptionHeadingElement.x - developmentDescriptionHeadingElement.width),
        height: (relevantAuthorityHeadingElement === undefined) ? (developmentDescriptionHeadingElement.height * 2) : (relevantAuthorityHeadingElement.y - developmentDescriptionHeadingElement.y)
    };
    let description = elements.filter(element => getPercentageOfElementInRectangle(element, descriptionBounds) > 10).map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");

    // Get the address and legal description.

    let houseNumberBounds: Rectangle = {
        x: houseNumberHeadingElement.x + houseNumberHeadingElement.width,
        y: houseNumberHeadingElement.y,
        width: (fullDevelopmentApprovalHeadingElement === undefined) ? (houseNumberHeadingElement.width * 2) : (fullDevelopmentApprovalHeadingElement.x - houseNumberHeadingElement.x - houseNumberHeadingElement.width),
        height: houseNumberHeadingElement.height
    };
    let houseNumberElement = elements.find(element => getPercentageOfElementInRectangle(element, houseNumberBounds) > 10);
    
    // Repeat same steps here for all other elements ...

    let address = "";
    let legalDescription = "";
    address = formatAddress(address);

    if (address === "") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find an address for the current development application.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }

    return {
        applicationNumber: applicationNumber,
        address: address,
        description: (description === "") ? "No description provided" : description,
        informationUrl: informationUrl,
        commentUrl: CommentUrl,
        scrapeDate: moment().format("YYYY-MM-DD"),
        receivedDate: receivedDate.isValid() ? receivedDate.format("YYYY-MM-DD") : "",
        legalDescription: legalDescription
    }
}

// Parses the development applications in the specified date range.

async function parsePdf(url: string) {
    console.log(`Reading development applications from ${url}.`);

    let developmentApplications = [];

    // Read the PDF.

    let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);

    // Parse the PDF.  Each page has the details of multiple applications.  Note that the PDF is
    // re-parsed on each iteration of the loop (ie. once for each page).  This then avoids large
    // memory usage by the PDF (just calling page._destroy() on each iteration of the loop appears
    // not to be enough to release all memory used by the PDF parsing).

    for (let pageIndex = 0; pageIndex < 5000; pageIndex++) {  // limit to an arbitrarily large number of pages (to avoid any chance of an infinite loop)
        let pdf = await pdfjs.getDocument({ data: buffer, disableFontFace: true, ignoreErrors: true });
        if (pageIndex >= pdf.numPages)
            break;

        console.log(`Reading and parsing applications from page ${pageIndex + 1} of ${pdf.numPages}.`);
        let page = await pdf.getPage(pageIndex + 1);
        let textContent = await page.getTextContent();
        let viewport = await page.getViewport(1.0);
    
        let elements: Element[] = textContent.items.map(item => {
            let transform = pdfjs.Util.transform(viewport.transform, item.transform);
    
            // Work around the issue https://github.com/mozilla/pdf.js/issues/8276 (heights are
            // exaggerated).  The problem seems to be that the height value is too large in some
            // PDFs.  Provide an alternative, more accurate height value by using a calculation
            // based on the transform matrix.
    
            let workaroundHeight = Math.sqrt(transform[2] * transform[2] + transform[3] * transform[3]);
            return { text: item.str, x: transform[4], y: transform[5], width: item.width, height: workaroundHeight };
        });

        // Release the memory used by the PDF now that it is no longer required (it will be
        // re-parsed on the next iteration of the loop for the next page).

        await pdf.destroy();
        if (global.gc)
            global.gc();

        // Sort the elements by Y co-ordinate and then by X co-ordinate.

        let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
        elements.sort(elementComparer);

        let developmentApplication = parseApplicationElements(elements, url);
        if (developmentApplication !== undefined)
            if (!developmentApplications.some(otherDevelopmentApplication => otherDevelopmentApplication.applicationNumber === developmentApplication.applicationNumber))  // ignore duplicates
                developmentApplications.push(developmentApplication);
    }

    return developmentApplications;
}

// Gets a random integer in the specified range: [minimum, maximum).

function getRandom(minimum: number, maximum: number) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}

// Pauses for the specified number of milliseconds.

function sleep(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();

    // Read the files containing all possible street names, street suffixes, suburb names and
    // hundred names.  Note that these are not currently used.

    StreetNames = {};
    for (let line of fs.readFileSync("streetnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetNameTokens = line.toUpperCase().split(",");
        let streetName = streetNameTokens[0].trim();
        let suburbName = streetNameTokens[1].trim();
        (StreetNames[streetName] || (StreetNames[streetName] = [])).push(suburbName);  // several suburbs may exist for the same street name
    }

    StreetSuffixes = {};
    for (let line of fs.readFileSync("streetsuffixes.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetSuffixTokens = line.toUpperCase().split(",");
        StreetSuffixes[streetSuffixTokens[0].trim()] = streetSuffixTokens[1].trim();
    }

    SuburbNames = {};
    for (let line of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let suburbTokens = line.toUpperCase().split(",");
        SuburbNames[suburbTokens[0].trim()] = suburbTokens[1].trim();
    }

    HundredNames = [];
    for (let line of fs.readFileSync("hundrednames.txt").toString().replace(/\r/g, "").trim().split("\n"))
        HundredNames.push(line.trim().toUpperCase());

    // Read the main page of development applications.

    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);

    let body = await request({ url: DevelopmentApplicationsUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);

    let pdfUrls: string[] = [];
    for (let element of $("td.uContentListDesc p a").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href
        if (pdfUrl.toLowerCase().includes(".pdf"))
            if (!pdfUrls.some(url => url === pdfUrl))
                pdfUrls.push(pdfUrl);
    }

    if (pdfUrls.length === 0) {
        console.log("No PDF files were found on the pages examined.");
        return;
    }

    // Select the most recent PDF.  And randomly select one other PDF (avoid processing all PDFs
    // at once because this may use too much memory, resulting in morph.io terminating the current
    // process).

    console.log(`Found ${pdfUrls.length} PDF file(s).  Selecting two to parse.`);

    let selectedPdfUrls: string[] = [];
    selectedPdfUrls.push(pdfUrls.shift());  // the most recent PDF
    if (pdfUrls.length > 0)
        selectedPdfUrls.push(pdfUrls[getRandom(0, pdfUrls.length)]);  // a randomly selected PDF
    if (getRandom(0, 2) === 0)
        selectedPdfUrls.reverse();

    for (let pdfUrl of selectedPdfUrls) {
        console.log(`Parsing document: ${pdfUrl}`);
        let developmentApplications = await parsePdf(pdfUrl);
        console.log(`Parsed ${developmentApplications.length} development application(s) from document: ${pdfUrl}`);

        // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in the
        // current process being terminated by morph.io).

        if (global.gc)
            global.gc();

        console.log(`Inserting development applications into the database.`);
        for (let developmentApplication of developmentApplications)
            await insertRow(database, developmentApplication);
    }
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
