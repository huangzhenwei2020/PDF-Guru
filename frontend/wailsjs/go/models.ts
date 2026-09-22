export namespace main {
	
	export class MyConfig {
	    pdf_path: string;
	    python_path: string;
	    tesseract_path: string;
	    pandoc_path: string;
	    hashcat_path: string;
	
	    static createFrom(source: any = {}) {
	        return new MyConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.pdf_path = source["pdf_path"];
	        this.python_path = source["python_path"];
	        this.tesseract_path = source["tesseract_path"];
	        this.pandoc_path = source["pandoc_path"];
	        this.hashcat_path = source["hashcat_path"];
	    }
	}
	export class WSPageInfo {
	    index: number;
	    width: number;
	    height: number;
	    rotation: number;
	
	    static createFrom(source: any = {}) {
	        return new WSPageInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.width = source["width"];
	        this.height = source["height"];
	        this.rotation = source["rotation"];
	    }
	}
	export class WSDocInfo {
	    docId: string;
	    path: string;
	    pageCount: number;
	    pages: WSPageInfo[];
	
	    static createFrom(source: any = {}) {
	        return new WSDocInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.docId = source["docId"];
	        this.path = source["path"];
	        this.pageCount = source["pageCount"];
	        this.pages = this.convertValues(source["pages"], WSPageInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class WSThumb {
	    pageIndex: number;
	    url: string;
	    width: number;
	    height: number;
	
	    static createFrom(source: any = {}) {
	        return new WSThumb(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.pageIndex = source["pageIndex"];
	        this.url = source["url"];
	        this.width = source["width"];
	        this.height = source["height"];
	    }
	}

}

